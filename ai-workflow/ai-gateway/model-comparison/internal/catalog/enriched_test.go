package catalog

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestPerformanceCurrentAndLegacyFields(t *testing.T) {
	var v EnrichedVariant
	if err := json.Unmarshal([]byte(`{"outputSpeed":100,"timeToFirstToken":1,"endToEndTime":9,"timeToFirstAnswerToken":2,"hosts":[{"host":"OpenAI","host_slug":"openai","performance":{"outputSpeed":200,"timeToFirstToken":0.5,"timeToFirstAnswerToken":1.5,"endToEndTime":7}}]}`), &v); err != nil {
		t.Fatal(err)
	}
	perf, source := variantPerformance(v, &v.Hosts[0])
	if source != "gateway_host" || *perf.OutputTokensPerSecond != 200 || *perf.TimeToFirstToken != 0.5 || *perf.TimeToFirstAnswer != 1.5 || *perf.EndToEnd != 7 {
		t.Fatalf("host performance: %+v (%s)", perf, source)
	}
	host := compactHost(v.Hosts[0])
	if host.OutputTokensPerSecond == nil || *host.OutputTokensPerSecond != 200 || *host.TimeToFirstToken != 0.5 {
		t.Fatalf("host details: %+v", host)
	}
	perf, source = variantPerformance(v, nil)
	if source != "aa_model" || *perf.OutputTokensPerSecond != 100 || *perf.TimeToFirstToken != 1 || *perf.TimeToFirstAnswer != 2 || *perf.EndToEnd != 9 {
		t.Fatalf("model performance: %+v (%s)", perf, source)
	}
	if err := json.Unmarshal([]byte(`{"timescaleData":{"medianOutputSpeed":33,"medianTimeToFirstChunk":3},"endToEndResponseTime":{"total":11}}`), &v); err != nil {
		t.Fatal(err)
	}
	perf, _ = variantPerformance(v, nil)
	if *perf.OutputTokensPerSecond != 33 || *perf.TimeToFirstToken != 3 || *perf.EndToEnd != 11 {
		t.Fatalf("legacy performance: %+v", perf)
	}
}

func enrichedVariant(slug, name, effort string, intel float64, scicode float64) EnrichedVariant {
	return EnrichedVariant{
		Slug:              slug,
		Name:              name,
		Effort:            effort,
		Efforts:           []string{effort},
		IntelligenceIndex: f(intel),
		Capabilities: map[string]*float64{
			"engineering":    f(58),
			"strategyAndOps": f(57),
		},
		Benchmarks: EnrichedBenchmarks{
			SciCode: f(scicode),
			HLE:     f(0.55),
		},
		Price1mInputTokens:  f(2),
		Price1mOutputTokens: f(10),
		IntelligenceIndexCostPerTask: &EnrichedCostPerTask{
			Cost: &EnrichedCost{Total: f(10)},
		},
		Hosts: []EnrichedHost{{
			Host:     "Vendor",
			HostSlug: "vendor",
			Pricing: EnrichedHostPricing{
				Price1mInputTokens:  f(2),
				Price1mOutputTokens: f(10),
				CostPerTask:         f(10),
			},
		}},
	}
}

func enrichedFile() EnrichedFile {
	release := EnrichedRelease{
		Slug:        "orbit-pro-2",
		Name:        "Orbit Pro 2",
		ReleaseDate: strptr("2026-09-28"),
		Creator:     &EnrichedCreator{Name: "Orbit Labs"},
	}
	variants := []EnrichedVariant{
		enrichedVariant("orbit-pro-2", "Orbit Pro 2 (Max)", "max", 54, 0.61),
		enrichedVariant("orbit-pro-2-low", "Orbit Pro 2 (Low)", "low", 25, 0.50),
	}
	return EnrichedFile{
		GeneratedAt: "2026-10-28T06:50:38Z",
		Source: EnrichedSource{
			Homepage:                 "https://artificialanalysis.ai",
			Attribution:              "Data from Artificial Analysis",
			IntelligenceIndexVersion: "5.0",
			FetchedAt:                "2026-10-28T06:50:38Z",
			Methodology:              "test",
		},
		Rows: []EnrichedGateway{
			{
				ProviderID:       "gw-vendor",
				ProviderName:     "Vendor",
				ModelID:          "orbit-2-pro-vendor",
				Aliases:          []string{"orbit-pro-2"},
				Mode:             "chat",
				InputPer1M:       f(2),
				OutputPer1M:      f(10),
				UpstreamProvider: "vendor",
				AA: EnrichedAA{
					Matched:            true,
					ProviderMatch:      EnrichedProviderMatch{AAHost: "vendor"},
					Release:            release,
					PrimaryVariantSlug: "orbit-pro-2",
					Variants:           variants,
					Match:              EnrichedMatch{Source: "model_id", Query: "orbit-2-pro-vendor", Score: 106},
				},
			},
			{
				ProviderID:       "gw-cloud",
				ProviderName:     "Cloud Provider",
				ModelID:          "orbit-2-pro-cloud",
				Mode:             "chat",
				InputPer1M:       f(2.5),
				OutputPer1M:      f(12),
				UpstreamProvider: "cloud",
				AA: EnrichedAA{
					Matched:            true,
					ProviderMatch:      EnrichedProviderMatch{AAHost: "cloud_host"},
					Release:            release,
					PrimaryVariantSlug: "orbit-pro-2",
					Variants:           variants,
					Match:              EnrichedMatch{Source: "model_id", Query: "orbit-2-pro-cloud", Score: 104},
				},
			},
			{
				ProviderID:   "gw-other",
				ProviderName: "Other Provider",
				ModelID:      "synth-audio-1.0",
				AA: EnrichedAA{
					Matched: false,
					Reason:  "AA text-model leaderboard has no audio-model entries.",
				},
			},
		},
	}
}

func TestBuildEnrichedAggregatesVariantsAndGatewayIDs(t *testing.T) {
	snap := BuildEnriched(EnrichedBuildInput{
		GeneratedAt: "2026-10-28T07:00:00Z",
		File:        enrichedFile(),
	})
	if snap.SchemaVersion != 2 {
		t.Fatalf("schema = %d, want 2", snap.SchemaVersion)
	}
	if snap.Counts.Rows != 2 || snap.Counts.Matched != 2 || snap.Counts.Unmatched != 1 {
		t.Fatalf("counts = %+v", snap.Counts)
	}
	if snap.Counts.Releases != 1 || snap.Counts.WithIntelligence != 2 {
		t.Fatalf("counts = %+v", snap.Counts)
	}
	if len(snap.UnmatchedDetails) != 1 || snap.UnmatchedDetails[0].Gateway != "synth-audio-1.0" {
		t.Fatalf("unmatched details = %+v", snap.UnmatchedDetails)
	}
	if len(snap.Metrics) == 0 {
		t.Fatal("expected metric definitions")
	}

	var base, low *Row
	for i := range snap.Models {
		switch snap.Models[i].Slug {
		case "orbit-pro-2":
			base = &snap.Models[i]
		case "orbit-pro-2-low":
			low = &snap.Models[i]
		}
	}
	if base == nil || low == nil {
		t.Fatalf("missing variant rows: %+v", snap.Models)
	}
	if len(base.Gateway) != 2 || base.Gateway[0] != "orbit-2-pro-cloud" {
		t.Errorf("gateway ids = %v", base.Gateway)
	}
	if !base.IsPrimary || low.IsPrimary {
		t.Errorf("primary flags = %v / %v", base.IsPrimary, low.IsPrimary)
	}
	if got := base.Scores["scicode"]; got == nil || math.Abs(*got-61) > 1e-9 {
		t.Errorf("normalized scicode = %v, want 61", got)
	}
	if got := base.RawScores["scicode"]; got == nil || math.Abs(*got-0.61) > 1e-9 {
		t.Errorf("raw scicode = %v, want 0.61", got)
	}
	if base.Pricing.EffectiveInput == nil || *base.Pricing.EffectiveInput != 2 {
		t.Errorf("effective input = %v", base.Pricing.EffectiveInput)
	}
	if base.Pricing.GatewayCostPerTask == nil || math.Abs(*base.Pricing.GatewayCostPerTask-10) > 1e-9 {
		t.Errorf("gateway cost per task = %v, want 10", base.Pricing.GatewayCostPerTask)
	}
	if base.Pricing.PriceSource != "gateway" || base.Pricing.CostPerTaskSource != "gateway_estimate" {
		t.Errorf("pricing sources = %q / %q", base.Pricing.PriceSource, base.Pricing.CostPerTaskSource)
	}
	if len(base.Hosts) != 1 || base.Hosts[0].HostSlug != "vendor" {
		t.Errorf("hosts = %+v", base.Hosts)
	}
}

func TestBuildEnrichedFallsBackToHostPrice(t *testing.T) {
	file := enrichedFile()
	file.Rows = file.Rows[:1]
	file.Rows[0].InputPer1M, file.Rows[0].OutputPer1M = nil, nil
	snap := BuildEnriched(EnrichedBuildInput{File: file})
	if len(snap.Models) != 2 {
		t.Fatalf("rows = %d", len(snap.Models))
	}
	row := snap.Models[0]
	if row.Pricing.PriceSource != "aa_host" {
		t.Errorf("price source = %q, want aa_host", row.Pricing.PriceSource)
	}
	if row.Pricing.GatewayInput != nil {
		t.Errorf("gateway price must stay null, got %v", row.Pricing.GatewayInput)
	}
	if row.Pricing.EffectiveInput == nil || *row.Pricing.EffectiveInput != 2 {
		t.Errorf("effective input = %v", row.Pricing.EffectiveInput)
	}
}

func strptr(s string) *string { return &s }

func f(v float64) *float64 { return &v }

func TestBuildEnrichedNeverEmitsGatewayURLs(t *testing.T) {
	// A catalog file carries base_url; the typed decode must drop it.
	var file EnrichedFile
	raw := `{"source":{"intelligence_index_version":"5.0"},"input":{"path":"/x/models.json"},"base_url":"https://gateway.example.invalid/prod","rows":[{"provider_id":"p","model_id":"m","base_url":"https://gateway.example.invalid/prod","mode":"chat","aa":{"matched":false,"reason":"r"}}]}`
	if err := json.Unmarshal([]byte(raw), &file); err != nil {
		t.Fatal(err)
	}
	data, err := Encode(BuildEnriched(EnrichedBuildInput{File: file}), "js")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "example.invalid") || strings.Contains(string(data), "base_url") {
		t.Fatalf("snapshot leaked gateway URL: %s", data)
	}
	if !strings.HasPrefix(string(data), "window.__MODEL_COMPARISON__ = {") {
		t.Fatalf("js snapshot prefix: %.60s", data)
	}
}

func TestEncodeFormats(t *testing.T) {
	snap := BuildEnriched(EnrichedBuildInput{File: enrichedFile()})
	js, err := Encode(snap, "js")
	if err != nil {
		t.Fatal(err)
	}
	var back Snapshot
	body := strings.TrimSuffix(strings.TrimPrefix(string(js), "window.__MODEL_COMPARISON__ = "), ";\n")
	if err := json.Unmarshal([]byte(body), &back); err != nil || len(back.Models) != 2 {
		t.Fatalf("js round trip: %v (%d models)", err, len(back.Models))
	}
	if _, err := Encode(snap, "xml"); err == nil {
		t.Fatal("expected error for unknown format")
	}
}

func TestBestCatalogRowPicksCheapestChatRow(t *testing.T) {
	rows := []EnrichedGateway{
		{ModelID: "a", Mode: "chat", InputPer1M: f(5), OutputPer1M: f(20)},
		{ModelID: "b", Mode: "chat", InputPer1M: f(1), OutputPer1M: f(4)},
		{ModelID: "c", Mode: "image_generation", InputPer1M: f(0), OutputPer1M: f(0)},
		{ModelID: "d", Mode: "chat", InputPer1M: f(-1), OutputPer1M: f(1)},
		{ModelID: "e", Mode: "chat"},
	}
	best, in, out := bestCatalogRow(rows)
	if best == nil || best.ModelID != "b" || *in != 1 || *out != 4 {
		t.Fatalf("best = %+v", best)
	}
	if best, _, _ := bestCatalogRow(rows[2:]); best != nil {
		t.Fatalf("expected no usable row, got %+v", best)
	}
}
