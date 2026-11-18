package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A tiny, entirely synthetic enriched file: one matched row, one unmatched.
const enrichedJSON = `{
  "generated_at": "2026-01-01T00:00:00Z",
  "source": {
    "intelligence_index_version": "5.0",
    "fetched_at": "2026-01-01T00:00:00Z",
    "homepage": "https://artificialanalysis.ai",
    "attribution": "Data from Artificial Analysis"
  },
  "input": { "path": "/tmp/models.json", "generated_at": "2026-01-01T00:00:00Z" },
  "rows": [
    {
      "provider_id": "gw-demo", "provider_name": "Demo", "model_id": "orbit-pro", "model_name": "orbit-pro",
      "mode": "chat", "input_per_1M": 1.5, "output_per_1M": 6, "upstream_provider": "demo",
      "base_url": "https://gateway.example.invalid/api",
      "aa": {
        "matched": true,
        "release": { "slug": "orbit-pro", "name": "Orbit Pro" },
        "primary_variant_slug": "orbit-pro",
        "variants": [ { "slug": "orbit-pro", "name": "Orbit Pro", "intelligenceIndex": 42, "price1mInputTokens": 2, "price1mOutputTokens": 8 } ]
      }
    },
    {
      "provider_id": "gw-demo", "provider_name": "Demo", "model_id": "synth-image", "mode": "image_generation",
      "aa": { "matched": false, "reason": "no image models" }
    }
  ]
}`

func TestRunWritesScriptAndJSON(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "enriched.json")
	if err := os.WriteFile(in, []byte(enrichedJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	jsOut := filepath.Join(dir, "data", "models.js")
	var stdout bytes.Buffer
	if err := run([]string{"--enriched", in, "--out", jsOut}, &stdout); err != nil {
		t.Fatal(err)
	}
	js, err := os.ReadFile(jsOut)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(js), "window.__MODEL_COMPARISON__ = {") || !strings.HasSuffix(string(js), ";\n") {
		t.Fatalf("not a classic script assignment: %.80s", js)
	}
	for _, want := range []string{`"orbit-pro"`, `"gateway_price_model": "orbit-pro"`, `"gateway_input_per_1m": 1.5`} {
		if !strings.Contains(string(js), want) {
			t.Errorf("output missing %s", want)
		}
	}
	if strings.Contains(string(js), "example.invalid") || strings.Contains(string(js), "base_url") {
		t.Error("output leaked the gateway base_url")
	}

	jsonOut := filepath.Join(dir, "models.json")
	if err := run([]string{"--enriched", in, "--out", jsonOut}, &stdout); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(jsonOut)
	if !strings.HasPrefix(string(data), "{") {
		t.Errorf("json output starts with %.20s", data)
	}
	if !strings.Contains(stdout.String(), "matched 1, unmatched 1") {
		t.Errorf("summary = %q", stdout.String())
	}
}

func TestRunValidatesInput(t *testing.T) {
	var out bytes.Buffer
	if err := run(nil, &out); err == nil {
		t.Error("expected an error without --enriched/--out")
	}
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"rows":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--enriched", bad, "--out", filepath.Join(t.TempDir(), "x.js")}, &out); err == nil || !strings.Contains(err.Error(), "no rows") {
		t.Errorf("expected no-rows error, got %v", err)
	}
	if err := run([]string{"--enriched", filepath.Join(t.TempDir(), "missing.json"), "--out", "x.js"}, &out); err == nil {
		t.Error("expected an error for a missing file")
	}
}
