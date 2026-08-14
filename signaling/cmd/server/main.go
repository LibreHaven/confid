// Command server runs the Confid signaling server.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/LibreHaven/confid/signaling/internal/hub"
	"github.com/LibreHaven/confid/signaling/internal/server"
)

func main() {
	addr := flag.String("addr", ":8787", "listen address")
	staticDir := flag.String("static", "", "serve the built frontend from this directory")
	flag.Parse()

	// Serverless platforms (Cloud Run, etc.) inject the listen port via
	// the PORT env var; it wins over -addr.
	if port := os.Getenv("PORT"); port != "" {
		*addr = ":" + port
	}

	h := hub.New()
	// Reclaim rooms whose invite expired before anyone joined.
	stopCleaner := make(chan struct{})
	defer close(stopCleaner)
	h.StartCleaner(time.Minute, stopCleaner)

	srv := &http.Server{
		Addr:    *addr,
		Handler: server.NewWithOptions(h, server.Options{StaticDir: *staticDir}).Handler(),
		// Slowloris guard: reject headers that take too long to arrive.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("signaling: listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("signaling: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("signaling: shutdown: %v", err)
	}
}
