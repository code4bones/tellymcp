package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type config struct {
	host       string
	port       int
	bearer     string
	socketPath string
}

type requestEnvelope struct {
	Target         string `json:"target"`
	Text           string `json:"text"`
	Action         string `json:"action"`
	Start          string `json:"start"`
	IncludeEscapes bool   `json:"includeEscapes"`
	FallbackLines  int    `json:"fallbackLines"`
	VisibleScreens int    `json:"visibleScreens"`
	SocketPath     string `json:"socketPath"`
}

type tmuxClient struct {
	socketPath string
}

func main() {
	cfg := config{
		host:       envOrDefault("TMUX_PROXY_HOST", "127.0.0.1"),
		port:       intEnvOrDefault("TMUX_PROXY_PORT", 8788),
		bearer:     strings.TrimSpace(os.Getenv("TMUX_PROXY_TOKEN")),
		socketPath: strings.TrimSpace(os.Getenv("TMUX_SOCKET_PATH")),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"service": "telegram-human-tmux-proxy",
		})
	})

	withAuth := func(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if cfg.bearer != "" {
				auth := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
				if auth == "" || subtle.ConstantTimeCompare([]byte(auth), []byte(cfg.bearer)) != 1 {
					writeText(w, http.StatusUnauthorized, "Unauthorized")
					return
				}
			}
			next(w, r)
		}
	}

	mux.HandleFunc("/window-height", withMethodAndAuth(http.MethodPost, withAuth(func(w http.ResponseWriter, r *http.Request) {
		body, ok := decodeBody(w, r)
		if !ok {
			return
		}
		client := cfg.clientFor(body.SocketPath)
		target := strings.TrimSpace(body.Target)
		if target == "" {
			writeText(w, http.StatusBadRequest, "target is required")
			return
		}
		height, err := client.windowHeight(r.Context(), target)
		if err != nil {
			writeTmuxError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"height": height})
	})))

	mux.HandleFunc("/capture-visible", withMethodAndAuth(http.MethodPost, withAuth(func(w http.ResponseWriter, r *http.Request) {
		body, ok := decodeBody(w, r)
		if !ok {
			return
		}
		client := cfg.clientFor(body.SocketPath)
		target := strings.TrimSpace(body.Target)
		if target == "" {
			writeText(w, http.StatusBadRequest, "target is required")
			return
		}
		fallbackLines := body.FallbackLines
		if fallbackLines <= 0 {
			fallbackLines = 300
		}
		visibleScreens := body.VisibleScreens
		if visibleScreens <= 0 {
			visibleScreens = 2
		}
		content, err := client.captureVisible(r.Context(), target, fallbackLines, visibleScreens)
		if err != nil {
			writeTmuxError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"content": content})
	})))

	mux.HandleFunc("/capture-range", withMethodAndAuth(http.MethodPost, withAuth(func(w http.ResponseWriter, r *http.Request) {
		body, ok := decodeBody(w, r)
		if !ok {
			return
		}
		client := cfg.clientFor(body.SocketPath)
		target := strings.TrimSpace(body.Target)
		start := strings.TrimSpace(body.Start)
		if target == "" || start == "" {
			writeText(w, http.StatusBadRequest, "target and start are required")
			return
		}
		content, err := client.captureRange(r.Context(), target, start, body.IncludeEscapes)
		if err != nil {
			writeTmuxError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"content": content})
	})))

	mux.HandleFunc("/send-action", withMethodAndAuth(http.MethodPost, withAuth(func(w http.ResponseWriter, r *http.Request) {
		body, ok := decodeBody(w, r)
		if !ok {
			return
		}
		client := cfg.clientFor(body.SocketPath)
		target := strings.TrimSpace(body.Target)
		action := strings.TrimSpace(strings.ToLower(body.Action))
		if target == "" || !isAllowedAction(action) {
			writeText(w, http.StatusBadRequest, "target and valid action are required")
			return
		}
		if err := client.sendAction(r.Context(), target, action); err != nil {
			writeTmuxError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})))

	mux.HandleFunc("/send-line", withMethodAndAuth(http.MethodPost, withAuth(func(w http.ResponseWriter, r *http.Request) {
		body, ok := decodeBody(w, r)
		if !ok {
			return
		}
		client := cfg.clientFor(body.SocketPath)
		target := strings.TrimSpace(body.Target)
		if target == "" {
			writeText(w, http.StatusBadRequest, "target is required")
			return
		}
		if err := client.sendLine(r.Context(), target, body.Text); err != nil {
			writeTmuxError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})))

	addr := fmt.Sprintf("%s:%d", cfg.host, cfg.port)
	log.Printf("tmux proxy listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func (c config) clientFor(socketPath string) tmuxClient {
	if strings.TrimSpace(socketPath) != "" {
		return tmuxClient{socketPath: strings.TrimSpace(socketPath)}
	}
	return tmuxClient{socketPath: c.socketPath}
}

func withMethodAndAuth(method string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			writeText(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		next(w, r)
	}
}

func decodeBody(w http.ResponseWriter, r *http.Request) (requestEnvelope, bool) {
	defer r.Body.Close()
	var body requestEnvelope
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeText(w, http.StatusBadRequest, "Invalid JSON body")
		return requestEnvelope{}, false
	}
	return body, true
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeText(w http.ResponseWriter, statusCode int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(statusCode)
	_, _ = w.Write([]byte(text))
}

func writeTmuxError(w http.ResponseWriter, err error) {
	if isTmuxUnavailableError(err) {
		writeText(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeText(w, http.StatusInternalServerError, err.Error())
}

func envOrDefault(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func intEnvOrDefault(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func isAllowedAction(action string) bool {
	switch action {
	case "up", "down", "enter", "slash", "delete":
		return true
	default:
		return false
	}
}

func isTmuxUnavailableError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "error connecting to /tmp/tmux-") ||
		strings.Contains(message, "No such file or directory") ||
		strings.Contains(message, "ENOENT") ||
		strings.Contains(message, "tmux is unavailable")
}

func (c tmuxClient) args(args ...string) []string {
	if c.socketPath == "" {
		return args
	}
	return append([]string{"-S", c.socketPath}, args...)
}

func (c tmuxClient) exec(ctx context.Context, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "tmux", c.args(args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return strings.ReplaceAll(string(output), "\x00", ""), nil
}

func (c tmuxClient) execIgnoreOutput(ctx context.Context, args ...string) error {
	_, err := c.exec(ctx, args...)
	return err
}

func (c tmuxClient) windowHeight(ctx context.Context, target string) (int, error) {
	output, err := c.exec(ctx, "display-message", "-p", "-t", target, "#{window_height}")
	if err != nil {
		return 0, err
	}
	height, err := strconv.Atoi(strings.TrimSpace(output))
	if err != nil || height <= 0 {
		return 0, nil
	}
	return height, nil
}

func (c tmuxClient) captureVisible(ctx context.Context, target string, fallbackLines, visibleScreens int) (string, error) {
	height, err := c.windowHeight(ctx, target)
	if err != nil {
		return "", err
	}
	if height <= 0 {
		height = fallbackLines
	}
	if height <= 0 {
		height = 300
	}
	if visibleScreens <= 0 {
		visibleScreens = 2
	}
	lines := height * visibleScreens

	output, err := c.exec(ctx, "capture-pane", "-p", "-e", "-a", "-t", target, "-S", fmt.Sprintf("-%d", lines))
	if err != nil {
		if !strings.Contains(err.Error(), "no alternate screen") {
			return "", err
		}
		return c.exec(ctx, "capture-pane", "-p", "-e", "-t", target, "-S", fmt.Sprintf("-%d", lines))
	}
	return output, nil
}

func (c tmuxClient) captureRange(ctx context.Context, target, start string, includeEscapes bool) (string, error) {
	args := []string{"capture-pane", "-p"}
	if includeEscapes {
		args = append(args, "-e")
	}
	args = append(args, "-t", target, "-S", start)
	return c.exec(ctx, args...)
}

func (c tmuxClient) sendAction(ctx context.Context, target, action string) error {
	key := "Enter"
	switch action {
	case "up":
		key = "Up"
	case "down":
		key = "Down"
	case "slash":
		key = "/"
	case "delete":
		key = "BSpace"
	}
	return c.execIgnoreOutput(ctx, "send-keys", "-t", target, key)
}

func (c tmuxClient) sendLine(ctx context.Context, target, text string) error {
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", " "), "\n", " "))
	bufferName := fmt.Sprintf("telegram-mcp-%d", time.Now().UnixNano())

	if normalized != "" {
		if err := c.execIgnoreOutput(ctx, "set-buffer", "-b", bufferName, normalized); err != nil {
			return err
		}
		defer func() {
			_ = c.execIgnoreOutput(context.Background(), "delete-buffer", "-b", bufferName)
		}()
		if err := c.execIgnoreOutput(ctx, "paste-buffer", "-d", "-b", bufferName, "-t", target); err != nil {
			return err
		}
	}

	return c.execIgnoreOutput(ctx, "send-keys", "-t", target, "Enter")
}
