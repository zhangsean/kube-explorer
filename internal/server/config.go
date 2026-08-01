package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rancher/apiserver/pkg/types"
	"github.com/rancher/apiserver/pkg/urlbuilder"
	steveauth "github.com/rancher/steve/pkg/auth"
	"github.com/rancher/steve/pkg/schema"
	"github.com/rancher/steve/pkg/server"
	"github.com/rancher/steve/pkg/server/cli"
	"github.com/rancher/steve/pkg/server/router"
	"github.com/rancher/wrangler/v3/pkg/kubeconfig"
	"github.com/rancher/wrangler/v3/pkg/ratelimit"
	"github.com/sirupsen/logrus"
	k8sschema "k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"

	"github.com/cnrancher/kube-explorer/internal/config"
	"github.com/cnrancher/kube-explorer/internal/resources/cluster"
	"github.com/cnrancher/kube-explorer/internal/ui"
	"github.com/cnrancher/kube-explorer/internal/version"
)

func ToServer(ctx context.Context, c *cli.Config, sqlCache bool) (*server.Server, error) {
	installNormalSubscribeCloseHook()
	var (
		auth                   steveauth.Middleware
		priorityListAPIHandler http.Handler
	)

	restConfig, err := kubeconfig.GetNonInteractiveClientConfigWithContext(c.KubeConfig, c.Context).ClientConfig()
	if err != nil {
		return nil, err
	}
	restConfig.RateLimiter = ratelimit.None

	if config.InsecureSkipTLSVerify {
		restConfig.Insecure = true
	}
	if restConfig.Insecure {
		restConfig.CAData = nil
		restConfig.CAFile = ""
		ensureUpgradeServerName(restConfig)
	}

	if c.WebhookConfig.WebhookAuthentication {
		auth, err = c.WebhookConfig.WebhookMiddleware()
		if err != nil {
			return nil, err
		}
	}

	controllers, err := server.NewController(restConfig, nil)
	if err != nil {
		return nil, err
	}

	ui, apiui := ui.New(&ui.Options{
		ReleaseSetting: version.IsRelease,
		Path:           func() string { return c.UIPath },
	})

	steveServer, err := server.New(ctx, restConfig, &server.Options{
		AuthMiddleware: auth,
		Controllers:    controllers,
		Next:           ui,
		SQLCache:       sqlCache,
		// router needs to hack here
		Router: func(h router.Handlers) http.Handler {
			priorityListAPIHandler = router.Routes(h)
			return handleProxyHeader(
				rewriteLocalCluster(
					optimizeListRequests(priorityListAPIHandler, auth == nil),
				),
			)
		},
	})
	if err != nil {
		return nil, err
	}

	steveServer.APIServer.CustomAPIUIResponseWriter(apiui.CSS(), apiui.JS(), func() string { return config.APIUIVersion })

	// registrer local cluster
	if err := cluster.Register(ctx, steveServer, c.Context); err != nil {
		return steveServer, err
	}
	// wrap default store
	steveServer.SchemaFactory.AddTemplate(schema.Template{
		Customize: func(a *types.APISchema) {
			if a.Store == nil {
				return
			}
			a.Store = &deleteOptionStore{
				Store: a.Store,
			}
		},
	})
	go func() {
		if err := controllers.Start(ctx); err != nil {
			logrus.Errorf("failed to start controllers: %v", err)
		}
	}()
	if err := waitForRequiredSchemas(ctx, steveServer.SchemaFactory, 90*time.Second); err != nil {
		return steveServer, err
	}
	if auth == nil {
		prewarmPriorityLists(ctx, priorityListAPIHandler)
	}
	return steveServer, nil
}

func ensureUpgradeServerName(restConfig *rest.Config) {
	if restConfig == nil || !restConfig.Insecure || restConfig.ServerName != "" {
		return
	}
	endpoint, err := url.Parse(restConfig.Host)
	if err != nil {
		return
	}
	restConfig.ServerName = endpoint.Hostname()
}

type schemaLookup interface {
	ByGVK(gvk k8sschema.GroupVersionKind) string
}

func waitForRequiredSchemas(ctx context.Context, lookup schemaLookup, timeout time.Duration) error {
	required := []k8sschema.GroupVersionKind{
		{Version: "v1", Kind: "Namespace"},
		{Group: "apps", Version: "v1", Kind: "Deployment"},
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		ready := true
		for _, gvk := range required {
			if lookup.ByGVK(gvk) == "" {
				ready = false
				break
			}
		}
		if ready {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("timed out waiting for required Kubernetes schemas")
		case <-ticker.C:
		}
	}
}

func rewriteLocalCluster(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		if strings.HasPrefix(req.URL.Path, "/k8s/clusters/local") {
			req.URL.Path = strings.TrimPrefix(req.URL.Path, "/k8s/clusters/local")
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
		}
		next.ServeHTTP(rw, req)
	})
}

func handleProxyHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		if value := req.Header.Get("X-Forwarded-Prefix"); value != "" {
			req.Header.Set(urlbuilder.PrefixHeader, value)
		}
		next.ServeHTTP(rw, req)
	})
}
