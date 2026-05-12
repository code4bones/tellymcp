package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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

type xchangeEnsureRequest struct {
	WorkspaceDir    string `json:"workspaceDir"`
	ExchangeDirName string `json:"exchangeDirName"`
}

type xchangeWriteRequest struct {
	WorkspaceDir    string `json:"workspaceDir"`
	ExchangeDirName string `json:"exchangeDirName"`
	FileName        string `json:"fileName"`
	ContentBase64   string `json:"contentBase64"`
}

type xchangeWriteRelativeRequest struct {
	WorkspaceDir    string `json:"workspaceDir"`
	ExchangeDirName string `json:"exchangeDirName"`
	RelativePath    string `json:"relativePath"`
	ContentBase64   string `json:"contentBase64"`
	Append          bool   `json:"append"`
}

type xchangeDeleteRequest struct {
	WorkspaceDir    string `json:"workspaceDir"`
	ExchangeDirName string `json:"exchangeDirName"`
	FilePath        string `json:"filePath"`
}

type workspaceReadRequest struct {
	WorkspaceDir string `json:"workspaceDir"`
	FilePath     string `json:"filePath"`
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

	case "/xchange/ensure":
		var req xchangeEnsureRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.WorkspaceDir) == "" || strings.TrimSpace(req.ExchangeDirName) == "" {
			writeText(w, http.StatusBadRequest, "workspaceDir and exchangeDirName are required")
			return "", "", nil
		}

		dir, err := ensureXchangeDir(req.WorkspaceDir, req.ExchangeDirName)
		if err != nil {
			return "", fmt.Sprintf("xchange-ensure workspace=%s", strings.TrimSpace(req.WorkspaceDir)), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"dir": dir})
		return "", fmt.Sprintf("xchange-ensure dir=%s", dir), nil

	case "/xchange/write":
		var req xchangeWriteRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.WorkspaceDir) == "" ||
			strings.TrimSpace(req.ExchangeDirName) == "" ||
			strings.TrimSpace(req.FileName) == "" ||
			strings.TrimSpace(req.ContentBase64) == "" {
			writeText(w, http.StatusBadRequest, "workspaceDir, exchangeDirName, fileName, and contentBase64 are required")
			return "", "", nil
		}

		outputPath, err := writeXchangeFile(req.WorkspaceDir, req.ExchangeDirName, req.FileName, req.ContentBase64)
		if err != nil {
			return "", fmt.Sprintf("xchange-write file=%s", strings.TrimSpace(req.FileName)), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"path": outputPath})
		return "", fmt.Sprintf("xchange-write path=%s", outputPath), nil

	case "/xchange/write-relative":
		var req xchangeWriteRelativeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.WorkspaceDir) == "" ||
			strings.TrimSpace(req.ExchangeDirName) == "" ||
			strings.TrimSpace(req.RelativePath) == "" ||
			strings.TrimSpace(req.ContentBase64) == "" {
			writeText(w, http.StatusBadRequest, "workspaceDir, exchangeDirName, relativePath, and contentBase64 are required")
			return "", "", nil
		}

		outputPath, err := writeXchangeRelativeFile(req.WorkspaceDir, req.ExchangeDirName, req.RelativePath, req.ContentBase64, req.Append)
		if err != nil {
			return "", fmt.Sprintf("xchange-write-relative path=%s", strings.TrimSpace(req.RelativePath)), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"path": outputPath})
		return "", fmt.Sprintf("xchange-write-relative path=%s", outputPath), nil

	case "/xchange/list":
		var req xchangeEnsureRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.WorkspaceDir) == "" || strings.TrimSpace(req.ExchangeDirName) == "" {
			writeText(w, http.StatusBadRequest, "workspaceDir and exchangeDirName are required")
			return "", "", nil
		}

		files, err := listXchangeFiles(req.WorkspaceDir, req.ExchangeDirName)
		if err != nil {
			return "", fmt.Sprintf("xchange-list workspace=%s", strings.TrimSpace(req.WorkspaceDir)), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"files": files})
		return "", fmt.Sprintf("xchange-list count=%d", len(files)), nil

	case "/xchange/delete":
		var req xchangeDeleteRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.WorkspaceDir) == "" ||
			strings.TrimSpace(req.ExchangeDirName) == "" ||
			strings.TrimSpace(req.FilePath) == "" {
			writeText(w, http.StatusBadRequest, "workspaceDir, exchangeDirName, and filePath are required")
			return "", "", nil
		}

		if err := deleteXchangeFile(req.WorkspaceDir, req.ExchangeDirName, req.FilePath); err != nil {
			return "", fmt.Sprintf("xchange-delete path=%s", strings.TrimSpace(req.FilePath)), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
		return "", fmt.Sprintf("xchange-delete path=%s", strings.TrimSpace(req.FilePath)), nil

	case "/workspace/read":
		var req workspaceReadRequest
		if err := decodeJSON(r, &req); err != nil {
			writeText(w, http.StatusBadRequest, "Invalid JSON body")
			return "", "", nil
		}
		if strings.TrimSpace(req.WorkspaceDir) == "" || strings.TrimSpace(req.FilePath) == "" {
			writeText(w, http.StatusBadRequest, "workspaceDir and filePath are required")
			return "", "", nil
		}

		contentBase64, err := readWorkspaceFile(req.WorkspaceDir, req.FilePath)
		if err != nil {
			return "", fmt.Sprintf("workspace-read path=%s", strings.TrimSpace(req.FilePath)), err
		}

		writeJSON(w, http.StatusOK, map[string]any{"contentBase64": contentBase64})
		return "", fmt.Sprintf("workspace-read path=%s", strings.TrimSpace(req.FilePath)), nil

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

func sanitizeFileName(fileName string) string {
	baseName := strings.TrimSpace(filepath.Base(fileName))
	if baseName == "" {
		return "file.bin"
	}

	var builder strings.Builder
	for _, ch := range baseName {
		switch {
		case ch == '/' || ch == '\\':
			builder.WriteByte('-')
		case ch >= 0 && ch <= 31:
			builder.WriteByte('-')
		case strings.ContainsRune(`<>:"|?*`, ch):
			builder.WriteByte('-')
		default:
			builder.WriteRune(ch)
		}
	}

	normalized := strings.Join(strings.Fields(strings.TrimSpace(builder.String())), " ")
	if normalized == "" {
		return "file.bin"
	}
	return normalized
}

func sanitizeRelativeXchangePath(relativePath string) (string, error) {
	parts := strings.FieldsFunc(relativePath, func(r rune) bool {
		return r == '/' || r == '\\'
	})
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" || trimmed == "." || trimmed == ".." {
			continue
		}
		filtered = append(filtered, trimmed)
	}

	normalized := strings.Join(filtered, "/")
	if normalized == "" {
		return "", fmt.Errorf("relativePath is required")
	}

	return normalized, nil
}

func allocateAvailableFilePath(dir string, fileName string) (string, error) {
	safeFileName := sanitizeFileName(fileName)
	extension := filepath.Ext(safeFileName)
	baseName := strings.TrimSuffix(safeFileName, extension)

	for attempt := 0; attempt < 1000; attempt += 1 {
		candidateName := safeFileName
		if attempt > 0 {
			candidateName = fmt.Sprintf("%s--%d%s", baseName, attempt, extension)
		}

		candidatePath := filepath.Join(dir, candidateName)
		_, err := os.Stat(candidatePath)
		if errors.Is(err, os.ErrNotExist) {
			return candidatePath, nil
		}
		if err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("could not allocate a unique file name in exchange directory")
}

func ensureXchangeDir(workspaceDir string, exchangeDirName string) (string, error) {
	resolvedDir := filepath.Clean(filepath.Join(strings.TrimSpace(workspaceDir), strings.TrimSpace(exchangeDirName)))
	if err := os.MkdirAll(resolvedDir, 0o755); err != nil {
		return "", err
	}
	return resolvedDir, nil
}

func resolvePathInsideWorkspace(workspaceDir string, filePath string) (string, error) {
	resolvedWorkspaceDir := filepath.Clean(strings.TrimSpace(workspaceDir))
	resolvedFilePath := strings.TrimSpace(filePath)
	if !filepath.IsAbs(resolvedFilePath) {
		resolvedFilePath = filepath.Join(resolvedWorkspaceDir, resolvedFilePath)
	}
	resolvedFilePath = filepath.Clean(resolvedFilePath)
	relative, err := filepath.Rel(resolvedWorkspaceDir, resolvedFilePath)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(relative, "..") || relative == "." {
		return "", fmt.Errorf("filePath is outside the workspace directory")
	}

	return resolvedFilePath, nil
}

func resolvePathInsideXchange(dir string, relativePath string) (string, error) {
	safeRelativePath, err := sanitizeRelativeXchangePath(relativePath)
	if err != nil {
		return "", err
	}

	resolvedDir := filepath.Clean(dir)
	resolvedPath := filepath.Clean(filepath.Join(resolvedDir, safeRelativePath))
	relative, err := filepath.Rel(resolvedDir, resolvedPath)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(relative, "..") || relative == "." {
		return "", fmt.Errorf("relativePath is outside the exchange directory")
	}

	return resolvedPath, nil
}

func writeXchangeFile(workspaceDir string, exchangeDirName string, fileName string, contentBase64 string) (string, error) {
	dir, err := ensureXchangeDir(workspaceDir, exchangeDirName)
	if err != nil {
		return "", err
	}

	content, err := base64.StdEncoding.DecodeString(contentBase64)
	if err != nil {
		return "", err
	}

	outputPath, err := allocateAvailableFilePath(dir, fileName)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(outputPath, content, 0o644); err != nil {
		return "", err
	}

	return outputPath, nil
}

func writeXchangeRelativeFile(workspaceDir string, exchangeDirName string, relativePath string, contentBase64 string, appendMode bool) (string, error) {
	dir, err := ensureXchangeDir(workspaceDir, exchangeDirName)
	if err != nil {
		return "", err
	}

	content, err := base64.StdEncoding.DecodeString(contentBase64)
	if err != nil {
		return "", err
	}

	outputPath, err := resolvePathInsideXchange(dir, relativePath)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return "", err
	}

	if appendMode {
		file, err := os.OpenFile(outputPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return "", err
		}
		defer file.Close()
		if _, err := file.Write(content); err != nil {
			return "", err
		}
		return outputPath, nil
	}

	if err := os.WriteFile(outputPath, content, 0o644); err != nil {
		return "", err
	}
	return outputPath, nil
}

func listXchangeFiles(workspaceDir string, exchangeDirName string) ([]string, error) {
	dir, err := ensureXchangeDir(workspaceDir, exchangeDirName)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		files = append(files, filepath.Join(dir, entry.Name()))
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i] > files[j]
	})

	return files, nil
}

func deleteXchangeFile(workspaceDir string, exchangeDirName string, filePath string) error {
	dir, err := ensureXchangeDir(workspaceDir, exchangeDirName)
	if err != nil {
		return err
	}

	resolvedDir := filepath.Clean(dir)
	resolvedFilePath := filepath.Clean(filePath)
	relative, err := filepath.Rel(resolvedDir, resolvedFilePath)
	if err != nil {
		return err
	}
	if strings.HasPrefix(relative, "..") || relative == "." {
		return fmt.Errorf("filePath is outside the exchange directory")
	}

	if err := os.Remove(resolvedFilePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	return nil
}

func readWorkspaceFile(workspaceDir string, filePath string) (string, error) {
	resolvedFilePath, err := resolvePathInsideWorkspace(workspaceDir, filePath)
	if err != nil {
		return "", err
	}

	content, err := os.ReadFile(resolvedFilePath)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(content), nil
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
