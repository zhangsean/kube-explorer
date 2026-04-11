package content

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

func NewFilepath(getPath func() string) Handler {
	return newFS(&filepathFS{
		getPath: getPath,
	})
}

var _ fsContent = &filepathFS{}

type filepathFS struct {
	getPath func() string
}

func cleanUIPath(path string) string {
	cleaned := strings.TrimSpace(path)
	return strings.TrimRightFunc(cleaned, func(r rune) bool {
		return unicode.IsSpace(r) || r == ',' || r == ';' || r == '\uFF0C' || r == '\uFF1B'
	})
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (f *filepathFS) resolveRoot() (string, error) {
	root := cleanUIPath(f.getPath())
	if root == "" {
		return "", errors.New("filepath fs is not ready")
	}

	var candidates []string
	candidates = append(candidates, root)
	if !filepath.IsAbs(root) {
		if exePath, err := os.Executable(); err == nil {
			candidates = append(candidates, filepath.Join(filepath.Dir(exePath), root))
		}
	}

	for _, candidate := range candidates {
		candidate = filepath.Clean(candidate)
		if pathExists(filepath.Join(candidate, "dashboard", "index.html")) {
			return candidate, nil
		}
		if pathExists(filepath.Join(candidate, "dashboard", "dist", "index.html")) {
			return candidate, nil
		}
		if pathExists(filepath.Join(candidate, "ui", "dashboard", "index.html")) {
			return filepath.Join(candidate, "ui"), nil
		}
		if pathExists(filepath.Join(candidate, "ui", "dashboard", "dist", "index.html")) {
			return filepath.Join(candidate, "ui"), nil
		}
	}

	return filepath.Clean(root), nil
}

func (f *filepathFS) ToFileServer(basePaths ...string) http.Handler {
	root, err := f.resolveRoot()
	if err != nil {
		return http.NotFoundHandler()
	}
	path := filepath.Join(append([]string{root}, basePaths...)...)
	return http.FileServer(http.Dir(path))
}

func (f *filepathFS) Open(name string) (fs.File, error) {
	root, err := f.resolveRoot()
	if err != nil {
		return nil, err
	}
	return http.Dir(root).Open(name)
}

func (f *filepathFS) Refresh() error {
	return nil
}
