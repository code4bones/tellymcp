package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type config struct {
	Host       string
	Port       string
	Token      string
	SocketPath string
}

type baseRequest struct {
	Target     string `json:"target"`
	SocketPath string `json:"socketPath"`
}

type windowHeightRequest struct {
	baseRequest
}

type captureVisibleRequest struct {
	baseRequest
	FallbackLines  int `json:"fallbackLines"`
	VisibleScreens int `json:"visibleScreens"`
}

type captureRangeRequest struct {
	baseRequest
	Start          string `json:"start"`
	IncludeEscapes bool   `json:"includeEscapes"`
}

type sendActionRequest struct {
	baseRequest
	Action string `json:"action"`
}

type sendLineRequest struct {
	baseRequest
	Text string `json:"text"`
}

func main() {
	loadDotEnv(".env")

	if _, err := exec.LookPath("tmux"); err != nil {
		log.Fatalf("tmux is not installed or not available in PATH: %v", err)
	}

	cfg := config{
		Host:       envOrDefault("TMUX_PROXY_HOST", "127.0.0.1"),
		Port:       envOrDefault("TMUX_PROXY_PORT", "8788"),
		Token:      strings.TrimSpace(os.Getenv("TMUX_PROXY_TOKEN")),
		SocketPath: strings.TrimSpace(os.Getenv("TMUX_SOCKET_PATH")),
	}

	log.Printf(
		"tmux proxy startup host=%s port=%s socketPath=%q tokenConfigured=%t",
		cfg.Host,
		cfg.Port,
		cfg.SocketPath,
		cfg.Token != "",
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		recorder := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		if r.Method != http.MethodGet {
			writeText(recorder, http.StatusMethodNotAllowed, "Method not allowed")
			logRequest(r, recorder.statusCode, "", "")
			return
		}

		writeJSON(recorder, http.StatusOK, map[string]any{
			"ok":      true,
			"service": "telegram-human-tmux-proxy",
		})
		logRequest(r, recorder.statusCode, "", "")
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		recorder := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		targetForLog := ""
		detailsForLog := ""

		if r.URL.Path == "/healthz" {
			writeText(recorder, http.StatusNotFound, "Not found")
			logRequest(r, recorder.statusCode, "", "")
			return
		}

		if cfg.Token != "" && !isAuthorized(r, cfg.Token) {
			writeText(recorder, http.StatusUnauthorized, "Unauthorized")
			logRequest(r, recorder.statusCode, "", "unauthorized")
			return
		}

		if r.Method != http.MethodPost {
			writeText(recorder, http.StatusMethodNotAllowed, "Method not allowed")
			logRequest(r, recorder.statusCode, "", "")
			return
		}

		target, details, err := routeRequest(recorder, r, cfg)
		targetForLog = target
		detailsForLog = details
		if err != nil {
			statusCode := http.StatusInternalServerError
			if isTmuxUnavailable(err) {
				statusCode = http.StatusServiceUnavailable
			}
			writeText(recorder, statusCode, err.Error())
			logRequest(r, recorder.statusCode, targetForLog, detailsForLog)
			log.Printf("tmux proxy error path=%s target=%q details=%q err=%q", r.URL.Path, targetForLog, detailsForLog, err.Error())
			return
		}

		logRequest(r, recorder.statusCode, targetForLog, detailsForLog)
	})

	addr := net.JoinHostPort(cfg.Host, cfg.Port)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("telegram-human-tmux-proxy listening on http://%s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(statusCode int) {
	r.statusCode = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func routeRequest(w http.ResponseWriter, r *http.Request, cfg config) (string, string, error) {
	switch r.URL.Path {
	case "/window-height":
		var req windowHeightRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.Target) == "" {
			writeText(w, http.StatusBadRequest, "target is required")
			return "", "", nil
		}

		height, err := getWindowHeight(cfg, req.SocketPath, req.Target)
		if err != nil {
			return req.Target, "", err
		}

		writeJSON(w, http.StatusOK, map[string]any{"height": height})
		return req.Target, "window-height", nil

	case "/capture-visible":
		var req captureVisibleRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.Target) == "" {
			writeText(w, http.StatusBadRequest, "target is required")
			return "", "", nil
		}

		fallbackLines := req.FallbackLines
		if fallbackLines <= 0 {
			fallbackLines = 300
		}
		visibleScreens := req.VisibleScreens
		if visibleScreens <= 0 {
			visibleScreens = 2
		}

		content, err := captureVisible(cfg, req.SocketPath, req.Target, fallbackLines, visibleScreens)
		if err != nil {
			return req.Target, fmt.Sprintf("capture-visible fallback=%d screens=%d", fallbackLines, visibleScreens), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"content": content})
		return req.Target, fmt.Sprintf("capture-visible fallback=%d screens=%d", fallbackLines, visibleScreens), nil

	case "/capture-range":
		var req captureRangeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.Target) == "" || strings.TrimSpace(req.Start) == "" {
			writeText(w, http.StatusBadRequest, "target and start are required")
			return "", "", nil
		}

		content, err := captureRange(cfg, req.SocketPath, req.Target, req.Start, req.IncludeEscapes)
		if err != nil {
			return req.Target, fmt.Sprintf("capture-range start=%s escapes=%t", req.Start, req.IncludeEscapes), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"content": content})
		return req.Target, fmt.Sprintf("capture-range start=%s escapes=%t", req.Start, req.IncludeEscapes), nil

	case "/send-action":
		var req sendActionRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.Target) == "" || !isAllowedAction(req.Action) {
			writeText(w, http.StatusBadRequest, "target and valid action are required")
			return "", "", nil
		}

		if err := sendAction(cfg, req.SocketPath, req.Target, strings.ToLower(strings.TrimSpace(req.Action))); err != nil {
			return req.Target, fmt.Sprintf("send-action action=%s", strings.ToLower(strings.TrimSpace(req.Action))), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return req.Target, fmt.Sprintf("send-action action=%s", strings.ToLower(strings.TrimSpace(req.Action))), nil

	case "/send-line":
		var req sendLineRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.Target) == "" {
			writeText(w, http.StatusBadRequest, "target is required")
			return "", "", nil
		}

		if err := sendLine(cfg, req.SocketPath, req.Target, req.Text); err != nil {
			return req.Target, fmt.Sprintf("send-line chars=%d", len(strings.TrimSpace(req.Text))), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return req.Target, fmt.Sprintf("send-line chars=%d", len(strings.TrimSpace(req.Text))), nil

	default:
		writeText(w, http.StatusNotFound, "Not found")
		return "", "", nil
	}
}

func logRequest(r *http.Request, statusCode int, target string, details string) {
	if target != "" || details != "" {
		log.Printf("tmux proxy request method=%s path=%s status=%d target=%q details=%q remote=%s", r.Method, r.URL.Path, statusCode, target, details, r.RemoteAddr)
		return
	}

	log.Printf("tmux proxy request method=%s path=%s status=%d remote=%s", r.Method, r.URL.Path, statusCode, r.RemoteAddr)
}

func envOrDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func decodeJSON(r *http.Request, dest any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	return decoder.Decode(dest)
}

func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}

		separator := strings.IndexByte(line, '=')
		if separator <= 0 {
			continue
		}

		key := strings.TrimSpace(line[:separator])
		if key == "" {
			continue
		}

		if _, exists := os.LookupEnv(key); exists {
			continue
		}

		value := strings.TrimSpace(line[separator+1:])
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}

		_ = os.Setenv(key, value)
	}
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeText(w http.ResponseWriter, statusCode int, text string) {
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(statusCode)
	_, _ = w.Write([]byte(text))
}

func isAuthorized(r *http.Request, token string) bool {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(authorization, prefix) {
		return false
	}

	provided := strings.TrimSpace(strings.TrimPrefix(authorization, prefix))
	if provided == "" || len(provided) != len(token) {
		return false
	}

	return subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1
}

func isAllowedAction(action string) bool {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "up", "down", "enter", "slash", "delete":
		return true
	default:
		return false
	}
}

func resolvedSocketPath(cfg config, requestSocketPath string) string {
	if trimmed := strings.TrimSpace(requestSocketPath); trimmed != "" {
		return trimmed
	}
	return cfg.SocketPath
}

func buildTmuxArgs(socketPath string, args ...string) []string {
	if socketPath == "" {
		return args
	}
	return append([]string{"-S", socketPath}, args...)
}

func execTmux(socketPath string, args ...string) (string, string, error) {
	command := exec.Command("tmux", buildTmuxArgs(socketPath, args...)...)
	output, err := command.CombinedOutput()
	text := string(output)
	if err != nil {
		return "", text, fmt.Errorf("Command failed: tmux %s\n%s", strings.Join(buildTmuxArgs(socketPath, args...), " "), text)
	}
	return text, "", nil
}

func execTmuxStdout(socketPath string, args ...string) (string, error) {
	command := exec.Command("tmux", buildTmuxArgs(socketPath, args...)...)
	output, err := command.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", fmt.Errorf("Command failed: tmux %s\n%s", strings.Join(buildTmuxArgs(socketPath, args...), " "), string(exitErr.Stderr))
		}
		return "", fmt.Errorf("Command failed: tmux %s\n%v", strings.Join(buildTmuxArgs(socketPath, args...), " "), err)
	}
	return string(output), nil
}

func isTmuxUnavailable(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "error connecting to /tmp/tmux-") ||
		strings.Contains(message, "No such file or directory") ||
		strings.Contains(message, "executable file not found") ||
		strings.Contains(message, "tmux is unavailable")
}

func getWindowHeight(cfg config, requestSocketPath string, target string) (*int, error) {
	stdout, err := execTmuxStdout(
		resolvedSocketPath(cfg, requestSocketPath),
		"display-message",
		"-p",
		"-t",
		target,
		"#{window_height}",
	)
	if err != nil {
		return nil, err
	}

	height, parseErr := strconv.Atoi(strings.TrimSpace(stdout))
	if parseErr != nil || height <= 0 {
		return nil, nil
	}

	return &height, nil
}

func captureRange(cfg config, requestSocketPath string, target string, start string, includeEscapes bool) (string, error) {
	args := []string{"capture-pane", "-p"}
	if includeEscapes {
		args = append(args, "-e")
	}
	args = append(args, "-t", target, "-S", start)

	stdout, err := execTmuxStdout(resolvedSocketPath(cfg, requestSocketPath), args...)
	if err != nil {
		return "", err
	}

	return strings.ReplaceAll(stdout, "\x00", ""), nil
}

func captureVisible(cfg config, requestSocketPath string, target string, fallbackLines int, visibleScreens int) (string, error) {
	height, err := getWindowHeight(cfg, requestSocketPath, target)
	if err != nil {
		return "", err
	}

	baseLines := fallbackLines
	if height != nil && *height > 0 {
		baseLines = *height
	}
	if baseLines <= 0 {
		baseLines = 300
	}
	if visibleScreens <= 0 {
		visibleScreens = 2
	}

	lines := baseLines * visibleScreens
	if lines <= 0 {
		lines = 1
	}

	socketPath := resolvedSocketPath(cfg, requestSocketPath)
	start := fmt.Sprintf("-%d", lines)

	stdout, err := execTmuxStdout(
		socketPath,
		"capture-pane",
		"-p",
		"-e",
		"-a",
		"-t",
		target,
		"-S",
		start,
	)
	if err != nil {
		if !strings.Contains(err.Error(), "no alternate screen") {
			return "", err
		}

		stdout, err = execTmuxStdout(
			socketPath,
			"capture-pane",
			"-p",
			"-e",
			"-t",
			target,
			"-S",
			start,
		)
		if err != nil {
			return "", err
		}
	}

	return strings.ReplaceAll(stdout, "\x00", ""), nil
}

func sendAction(cfg config, requestSocketPath string, target string, action string) error {
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

	_, _, err := execTmux(resolvedSocketPath(cfg, requestSocketPath), "send-keys", "-t", target, key)
	return err
}

func sendLine(cfg config, requestSocketPath string, target string, text string) error {
	socketPath := resolvedSocketPath(cfg, requestSocketPath)
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", " "), "\n", " "))
	bufferName := fmt.Sprintf("telegram-mcp-%x", time.Now().UnixNano())

	if normalized != "" {
		if _, _, err := execTmux(socketPath, "set-buffer", "-b", bufferName, normalized); err != nil {
			return err
		}

		defer func() {
			_, _, _ = execTmux(socketPath, "delete-buffer", "-b", bufferName)
		}()

		if _, _, err := execTmux(socketPath, "paste-buffer", "-d", "-b", bufferName, "-t", target); err != nil {
			return err
		}

		time.Sleep(75 * time.Millisecond)
	}

	_, _, err := execTmux(socketPath, "send-keys", "-t", target, "C-m")
	return err
}
