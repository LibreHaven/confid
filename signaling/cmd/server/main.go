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
	flag.Parse()

	h := hub.New()
	srv := &http.Server{
		Addr:    *addr,
		Handler: server.New(h).Handler(),
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
