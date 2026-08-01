package server

import (
	"context"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

func TestEnsureUpgradeServerName(t *testing.T) {
	tests := []struct {
		name       string
		config     *rest.Config
		serverName string
	}{
		{
			name:       "insecure config uses API host for SNI",
			config:     &rest.Config{Host: "https://dev.k8s.zjwm.cc:6443", TLSClientConfig: rest.TLSClientConfig{Insecure: true}},
			serverName: "dev.k8s.zjwm.cc",
		},
		{
			name:       "explicit server name is preserved",
			config:     &rest.Config{Host: "https://dev.k8s.zjwm.cc", TLSClientConfig: rest.TLSClientConfig{Insecure: true, ServerName: "api.internal"}},
			serverName: "api.internal",
		},
		{
			name:       "verified TLS remains unchanged",
			config:     &rest.Config{Host: "https://dev.k8s.zjwm.cc"},
			serverName: "",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ensureUpgradeServerName(test.config)
			if test.config.ServerName != test.serverName {
				t.Fatalf("expected server name %q, got %q", test.serverName, test.config.ServerName)
			}
		})
	}
}

type testSchemaLookup struct {
	sync.RWMutex
	ids map[schema.GroupVersionKind]string
}

func (s *testSchemaLookup) ByGVK(gvk schema.GroupVersionKind) string {
	s.RLock()
	defer s.RUnlock()
	return s.ids[gvk]
}

func (s *testSchemaLookup) set(gvk schema.GroupVersionKind, id string) {
	s.Lock()
	defer s.Unlock()
	s.ids[gvk] = id
}

func TestWaitForRequiredSchemas(t *testing.T) {
	lookup := &testSchemaLookup{ids: map[schema.GroupVersionKind]string{}}
	go func() {
		time.Sleep(20 * time.Millisecond)
		lookup.set(schema.GroupVersionKind{Version: "v1", Kind: "Namespace"}, "namespace")
		lookup.set(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}, "apps.deployment")
	}()

	if err := waitForRequiredSchemas(context.Background(), lookup, time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestWaitForRequiredSchemasTimesOut(t *testing.T) {
	lookup := &testSchemaLookup{ids: map[schema.GroupVersionKind]string{}}
	if err := waitForRequiredSchemas(context.Background(), lookup, 10*time.Millisecond); err == nil {
		t.Fatal("expected readiness timeout")
	}
}
