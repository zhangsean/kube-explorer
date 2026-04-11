package content

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
)

var _ Handler = &handler{}

func newFS(content fsContent) Handler {
	return &handler{
		content: content,
		cacheFS: &sync.Map{},
	}
}

type handler struct {
	content fsContent
	cacheFS *sync.Map
}

func (h *handler) pathExist(pathValue string) bool {
	cleanPath := path.Clean("/" + pathValue)
	name := strings.TrimPrefix(cleanPath, "/")
	if name == "." {
		name = ""
	}
	_, err := h.content.Open(name)
	return err == nil
}

func (h *handler) distAssetPath(pathValue string) (string, bool) {
	cleanPath := path.Clean("/" + pathValue)
	name := strings.TrimPrefix(cleanPath, "/")
	if !strings.HasPrefix(name, "dashboard/") || strings.HasPrefix(name, "dashboard/dist/") {
		return "", false
	}
	rest := strings.TrimPrefix(name, "dashboard/")
	if rest == "" || rest == "." || rest == "index.html" {
		return path.Join("dashboard", "dist", "index.html"), true
	}
	return path.Join("dashboard", "dist", rest), true
}

func (h *handler) serveContent(basePaths ...string) http.Handler {
	key := path.Join(basePaths...)
	if rtn, ok := h.cacheFS.Load(key); ok {
		return rtn.(http.Handler)
	}

	rtn := h.content.ToFileServer(basePaths...)
	h.cacheFS.Store(key, rtn)
	return rtn
}

func (h *handler) Refresh() {
	h.cacheFS.Range(func(key, _ any) bool {
		h.cacheFS.Delete(key)
		return true
	})
}

func (h *handler) ServeAssets(middleware func(http.Handler) http.Handler, next http.Handler) http.Handler {
	assets := middleware(h.serveContent())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if distPath, ok := h.distAssetPath(r.URL.Path); ok && h.pathExist(distPath) {
			rewritten := r.Clone(r.Context())
			rewrittenURL := *r.URL
			rewrittenURL.Path = "/" + distPath
			rewritten.URL = &rewrittenURL
			assets.ServeHTTP(w, rewritten)
			return
		}

		if h.pathExist(r.URL.Path) {
			assets.ServeHTTP(w, r)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (h *handler) ServeFaviconDashboard() http.Handler {
	return h.serveContent("dashboard")

}

func (h *handler) GetIndex() ([]byte, error) {
	indexCandidates := []string{
		path.Join("dashboard", "index.html"),
		path.Join("dashboard", "dist", "index.html"),
	}

	var f fs.File
	var err error
	for _, indexPath := range indexCandidates {
		f, err = h.content.Open(indexPath)
		if err == nil {
			defer f.Close()
			return io.ReadAll(f)
		}
	}
	return nil, err
}
