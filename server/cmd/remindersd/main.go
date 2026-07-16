// remindersd is a tiny cross-device reminder service for desktop-pet.
// It exposes /api/reminders CRUD with a single bearer-token check.
// Storage is SQLite (modernc.org/sqlite, pure Go, no CGO) at
// ./reminders.db; the file is created on first boot.
//
// Run:
//   REMINDERS_TOKEN=<long-random-string> ./remindersd
//
// Listens on :8080 by default. Put Caddy / nginx in front for TLS.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	_ "embed"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	_ "modernc.org/sqlite"
)

//go:embed h5/index.html
var h5Content string

const (
	defaultAddr      = ":8080"
	tokenEnv         = "REMINDERS_TOKEN"
	// ReadTimeout caps how long the client may take to send the
	// request body. Generous so a slow mobile network doesn't trip it.
	fetchTimeout = 15 * time.Second
	// WriteTimeout MUST be 0 (or very large) for the SSE stream.
	// Go's http.Server treats WriteTimeout as a per-write deadline —
	// any gap between flushes longer than WriteTimeout will close the
	// connection. Even with 20s server-side keepalives, the connection
	// would die after WriteTimeout, killing SSE pushes.
	//
	// Disabling it is safe for our use case: the SSE handler holds
	// the request context, and the periodic keepalive ticker (and
	// per-event flushes) keep the socket active. Other handlers are
	// short-lived and have no need for a write deadline.
	writeTimeout     = 0
	idleTimeout      = 120 * time.Second
	schemaVersionTag = "schema_version"
)

type Reminder struct {
	ID           string `json:"id"`
	UserID       string `json:"userId"`
	Text         string `json:"text"`
	FireAt       int64  `json:"fireAt"`
	Recurring    string `json:"recurring"`
	Acknowledged bool   `json:"acknowledged"`
	CreatedAt    int64  `json:"createdAt"`
}

func main() {
	token := os.Getenv(tokenEnv)
	if token == "" {
		log.Fatalf("[remindersd] %s env var is required", tokenEnv)
	}
	log.Printf("[remindersd] starting, token len=%d", len(token))

	db, err := sql.Open("sqlite", "./reminders.db?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		log.Fatalf("[remindersd] open db: %v", err)
	}
	defer db.Close()
	log.Printf("[remindersd] db opened")

	if _, err := db.ExecContext(context.Background(), `
		CREATE TABLE IF NOT EXISTS reminders (
			id           TEXT PRIMARY KEY,
			user_id      TEXT NOT NULL,
			text         TEXT NOT NULL,
			fire_at      INTEGER NOT NULL,
			recurring    TEXT NOT NULL DEFAULT 'none',
			acknowledged INTEGER NOT NULL DEFAULT 0,
			created_at   INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_reminders_user_fire
			ON reminders(user_id, fire_at);
	`); err != nil {
		log.Fatalf("[remindersd] create table: %v", err)
	}
	log.Printf("[remindersd] schema ready")

	srv := newServer(db, token)
	srv.startScheduler()
	log.Printf("[remindersd] scheduler started")

	r := chi.NewRouter()
	r.Use(corsForLocalDev)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Serve the H5 mobile page at root. The HTML is embedded directly
	// into the binary at compile time via go:embed above.
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(h5Content))
	})

	r.Route("/api/reminders", func(r chi.Router) {
		r.Use(srv.requireAuth)
		r.Get("/", srv.list)
		r.Get("/stream", srv.sseHandler)
		r.Post("/", srv.create)
		r.Delete("/{id}", srv.delete)
	})

	addr := os.Getenv("REMINDERS_ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  fetchTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  idleTimeout,
	}
	log.Printf("[remindersd] listening on %s", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[remindersd] serve: %v", err)
	}
}

type server struct {
	db    *sql.DB
	token string

	// SSE — long-lived connections that receive new reminders in
	// real-time instead of polling.
	sseMu      sync.RWMutex
	sseClients map[string]chan Reminder

	// Scheduler bookkeeping — guards pending time.AfterFunc handles
	// so a reminder can be re-created (re-armed) without leaking the
	// previous timer.
	schedMu  sync.Mutex
	schedOne map[string]*time.Timer
}

func newServer(db *sql.DB, token string) *server {
	return &server{
		db:         db,
		token:      token,
		sseClients: make(map[string]chan Reminder),
		schedOne:   make(map[string]*time.Timer),
	}
}

// startScheduler boots two background goroutines:
//   1. Hydrate any reminders that fired while the server was offline
//      (fire_at < now). Hydration runs once at boot; late-fire below
//      handles anything created afterwards.
//   2. On every create, arm a time.AfterFunc that, when the timer
//      expires, marks the row acknowledged + broadcasts it to all
//      SSE clients + DELETEs it from the DB.
func (s *server) startScheduler() {
	go func() {
		ctx := context.Background()
		rows, err := s.db.QueryContext(ctx,
			`SELECT id, user_id, text, fire_at, recurring, acknowledged, created_at
			   FROM reminders
			  WHERE acknowledged = 0
			    AND fire_at > 0
			    AND fire_at <= ?
			  ORDER BY fire_at ASC`,
			time.Now().UnixMilli(),
		)
		if err != nil {
			log.Printf("[remindersd] hydrate scan failed: %v", err)
			return
		}
		defer rows.Close()
		count := 0
		for rows.Next() {
			var r Reminder
			var ack int
			if err := rows.Scan(&r.ID, &r.UserID, &r.Text, &r.FireAt, &r.Recurring, &ack, &r.CreatedAt); err != nil {
				log.Printf("[remindersd] hydrate scan row: %v", err)
				continue
			}
			r.Acknowledged = ack != 0
			s.sseBroadcast(r)
			count++
		}
		if count > 0 {
			log.Printf("[remindersd] hydrated %d missed reminder(s) at boot", count)
		}
	}()
}

// armFire schedules r to be broadcast + deleted at r.FireAt. If the
// reminder is already past due, fire it immediately. Cancels any
// previous timer for the same id so re-creating a row doesn't leak.
func (s *server) armFire(r Reminder) {
	s.schedMu.Lock()
	if prev, ok := s.schedOne[r.ID]; ok {
		prev.Stop()
	}
	s.schedMu.Unlock()

	delay := time.Until(time.UnixMilli(r.FireAt))
	if delay <= 0 {
		// Already past due — fire on the next tick to avoid blocking
		// the request goroutine.
		log.Printf("[remindersd] %s already past due (delay=%s), firing immediately", r.ID, delay)
		go s.fire(r)
		return
	}
	s.schedMu.Lock()
	s.schedOne[r.ID] = time.AfterFunc(delay, func() { s.fire(r) })
	s.schedMu.Unlock()
	log.Printf("[remindersd] armed %s fireAt=%s delay=%s", r.ID, time.UnixMilli(r.FireAt).Format(time.RFC3339), delay)
}

// fire is the terminal handler: broadcast to SSE clients, mark
// acknowledged, DELETE the row. Errors are logged but not retried —
// the desktop client polls as a fallback and will re-fire on its
// side if this fails.
func (s *server) fire(r Reminder) {
	s.sseMu.RLock()
	clientCount := len(s.sseClients)
	s.sseMu.RUnlock()
	log.Printf("[remindersd] FIRE %s -> broadcasting to %d SSE client(s)", r.ID, clientCount)
	s.sseBroadcast(r)
	s.schedMu.Lock()
	delete(s.schedOne, r.ID)
	s.schedMu.Unlock()
	if _, err := s.db.ExecContext(context.Background(),
		`DELETE FROM reminders WHERE id = ? AND user_id = ?`,
		r.ID, r.UserID,
	); err != nil {
		log.Printf("[remindersd] post-fire DELETE %s failed: %v", r.ID, err)
	}
}

func (s *server) sseBroadcast(r Reminder) {
	s.sseMu.RLock()
	defer s.sseMu.RUnlock()
	data, _ := json.Marshal(r)
	for id, ch := range s.sseClients {
		select {
		case ch <- r:
		default:
			// Client too slow — drop and close.
			close(ch)
			delete(s.sseClients, id)
		}
	}
	// Also flush to any HTTP response writer that's already set up
	// (the EventSource handler below writes directly).
	_ = data
}

func (s *server) sseHandler(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan Reminder, 10)
	clientID := fmt.Sprintf("sse_%d", time.Now().UnixNano())
	s.sseMu.Lock()
	s.sseClients[clientID] = ch
	totalClients := len(s.sseClients)
	s.sseMu.Unlock()
	log.Printf("[remindersd] SSE connect %s (total clients: %d)", clientID, totalClients)

	defer func() {
		s.sseMu.Lock()
		delete(s.sseClients, clientID)
		remaining := len(s.sseClients)
		s.sseMu.Unlock()
		log.Printf("[remindersd] SSE disconnect %s (remaining clients: %d, ctxErr=%v)",
			clientID, remaining, r.Context().Err())
	}()

	// Send an initial heartbeat so the client knows the connection is up.
	_, _ = fmt.Fprintf(w, "event: heartbeat\ndata: connected\n\n")
	flusher.Flush()

	// Periodic keepalive so intermediate proxies (nginx, cloudflare)
	// don't reap the connection during long quiet periods.
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			_, _ = fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		case reminder, ok := <-ch:
			if !ok {
				return
			}
			data, _ := json.Marshal(reminder)
			_, _ = fmt.Fprintf(w, "event: reminder\ndata: %s\n\n", data)
			flusher.Flush()
		}
	}
}

func (s *server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Accept token from Authorization header (standard) OR from
		// query param ?token=xxx (EventSource can't set custom headers).
		token := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(token) > len(prefix) && token[:len(prefix)] == prefix && token[len(prefix):] == s.token {
			next.ServeHTTP(w, r)
			return
		}
		if r.URL.Query().Get("token") == s.token {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	if userID == "" {
		http.Error(w, "userId query param required", http.StatusBadRequest)
		return
	}
	rows, err := s.db.QueryContext(r.Context(),
		`SELECT id, user_id, text, fire_at, recurring, acknowledged, created_at
		   FROM reminders
		  WHERE user_id = ?
		    AND acknowledged = 0
		    AND fire_at > 0
		  ORDER BY fire_at ASC`,
		userID,
	)
	if err != nil {
		http.Error(w, "db: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	out := []Reminder{}
	for rows.Next() {
		var r Reminder
		var ack int
		if err := rows.Scan(&r.ID, &r.UserID, &r.Text, &r.FireAt, &r.Recurring, &ack, &r.CreatedAt); err != nil {
			http.Error(w, "scan: "+err.Error(), http.StatusInternalServerError)
			return
		}
		r.Acknowledged = ack != 0
		out = append(out, r)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	var body Reminder
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Printf("[remindersd] create: bad json: %v", err)
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.UserID == "" || body.Text == "" || body.FireAt == 0 || body.ID == "" {
		log.Printf("[remindersd] create: missing fields: %+v", body)
		http.Error(w, "id, userId, text, fireAt required", http.StatusBadRequest)
		return
	}
	if body.Recurring == "" {
		body.Recurring = "none"
	}
	if body.CreatedAt == 0 {
		body.CreatedAt = time.Now().UnixMilli()
	}
	_, err := s.db.ExecContext(r.Context(),
		`INSERT INTO reminders (id, user_id, text, fire_at, recurring, acknowledged, created_at)
		                       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		body.ID, body.UserID, body.Text, body.FireAt, body.Recurring, boolToInt(body.Acknowledged), body.CreatedAt,
	)
	if err != nil {
		log.Printf("[remindersd] create insert failed: %v", err)
		http.Error(w, "insert: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("[remindersd] create ok id=%s userId=%s fireAt=%s",
		body.ID, body.UserID, time.UnixMilli(body.FireAt).Format(time.RFC3339))
	// Arm the per-reminder timer so it actually fires at fire_at
	// instead of waiting for the desktop client to poll. Without
	// this, the SSE handler would only get pushes for reminders
	// created while a desktop was connected AND would never fire on
	// schedule.
	s.armFire(body)
	writeJSON(w, http.StatusCreated, body)
}

func (s *server) delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := r.URL.Query().Get("userId")
	if userID == "" {
		http.Error(w, "userId query param required", http.StatusBadRequest)
		return
	}
	// Cancel any pending fire timer for this id — otherwise a
	// desktop that acknowledged early would still get a stale
	// broadcast when the timer expires.
	s.schedMu.Lock()
	if t, ok := s.schedOne[id]; ok {
		t.Stop()
		delete(s.schedOne, id)
	}
	s.schedMu.Unlock()

	_, err := s.db.ExecContext(r.Context(),
		`DELETE FROM reminders WHERE id = ? AND user_id = ?`,
		id, userID,
	)
	if err != nil {
		http.Error(w, "delete: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// corsForLocalDev is intentionally permissive on CORS but still
// requires Authorization — the API has no real public surface, the
// CORS exception is just so the H5 page (served by the same reverse
// proxy) can call fetch() with a custom header from any origin. If
// you expose this server on the public internet, drop this middleware.
func corsForLocalDev(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
