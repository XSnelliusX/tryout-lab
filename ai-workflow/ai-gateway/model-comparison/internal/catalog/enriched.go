package catalog

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

// EnrichedFile is the JSON written by parse_aa.mjs. It contains one row
// per gateway model, with the matched AA release and every AA variant attached.
type EnrichedFile struct {
	GeneratedAt string            `json:"generated_at"`
	Source      EnrichedSource    `json:"source"`
	Input       EnrichedInput     `json:"input"`
	Summary     EnrichedSummary   `json:"summary"`
	Rows        []EnrichedGateway `json:"rows"`
}

type EnrichedSource struct {
	Provider                 string             `json:"provider"`
	Homepage                 string             `json:"homepage"`
	Attribution              string             `json:"attribution"`
	IntelligenceIndexVersion string             `json:"intelligence_index_version"`
	FetchedAt                string             `json:"fetched_at"`
	Methodology              string             `json:"methodology"`
	Pages                    []string           `json:"pages"`
	Manifests                []EnrichedManifest `json:"manifests"`
}

type EnrichedManifest struct {
	Page        string `json:"page"`
	PageURL     string `json:"page_url"`
	Path        string `json:"path"`
	Bytes       int    `json:"bytes"`
	SHA256      string `json:"sha256"`
	DatasetType string `json:"dataset_type"`
	Count       int    `json:"count"`
}

type EnrichedInput struct {
	Path          string `json:"path"`
	GeneratedAt   string `json:"generated_at"`
	Fingerprint   string `json:"fingerprint"`
	DeclaredCount int    `json:"declared_count"`
	Rows          int    `json:"rows"`
}

type EnrichedSummary struct {
	GatewayRows              int `json:"gateway_rows"`
	MatchedRows              int `json:"matched_rows"`
	UnmatchedRows            int `json:"unmatched_rows"`
	AAVariantsAttached       int `json:"aa_variants_attached"`
	PrimaryWithIntelligence  int `json:"primary_with_intelligence_index"`
	PrimaryWithCapabilities  int `json:"primary_with_capabilities"`
	PrimaryWithEvals         int `json:"primary_with_evals"`
	DeprecatedReleaseMatches int `json:"deprecated_release_matches"`
	ProviderHostFound        int `json:"provider_host_found"`
	AmbiguousMatches         int `json:"ambiguous_matches"`
	EffortUnavailable        int `json:"effort_unavailable"`
	AAReleaseGroups          int `json:"aa_release_groups"`
	AAVariantsTotal          int `json:"aa_variants_total"`
	AAVariantsWithHosts      int `json:"aa_variants_with_hosts"`
}

type EnrichedGateway struct {
	ProviderID       string     `json:"provider_id"`
	ProviderName     string     `json:"provider_name"`
	ModelID          string     `json:"model_id"`
	ModelName        string     `json:"model_name"`
	Aliases          []string   `json:"aliases"`
	Mode             string     `json:"mode"`
	MaxInputTokens   *int       `json:"max_input_tokens"`
	MaxOutputTokens  *int       `json:"max_output_tokens"`
	InputPer1M       *float64   `json:"input_per_1M"`
	OutputPer1M      *float64   `json:"output_per_1M"`
	UpstreamProvider string     `json:"upstream_provider"`
	UpstreamModel    string     `json:"upstream_model"`
	AA               EnrichedAA `json:"aa"`
}

type EnrichedAA struct {
	Matched            bool                   `json:"matched"`
	Reason             string                 `json:"reason"`
	ClosestMatches     []EnrichedClosest      `json:"closest_matches"`
	Release            EnrichedRelease        `json:"release"`
	Match              EnrichedMatch          `json:"match"`
	PrimaryVariant     EnrichedVariantSummary `json:"primary_variant"`
	PrimaryVariantSlug string                 `json:"primary_variant_slug"`
	PrimarySelection   string                 `json:"primary_selection_reason"`
	EffortLevels       []string               `json:"effort_levels"`
	ProviderMatch      EnrichedProviderMatch  `json:"provider_match"`
	Summary            EnrichedAASummary      `json:"summary"`
	Warnings           []string               `json:"warnings"`
	Variants           []EnrichedVariant      `json:"variants"`
}

type EnrichedClosest struct {
	ReleaseSlug string  `json:"release_slug"`
	ReleaseName string  `json:"release_name"`
	Score       float64 `json:"score"`
	Deprecated  bool    `json:"deprecated"`
}

type EnrichedRelease struct {
	Slug         string           `json:"slug"`
	Name         string           `json:"name"`
	Deprecated   bool             `json:"deprecated"`
	DeprecatedTo *string          `json:"deprecated_to"`
	ReleaseDate  *string          `json:"release_date"`
	Creator      *EnrichedCreator `json:"creator"`
	VariantCount int              `json:"variant_count"`
}

type EnrichedCreator struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type EnrichedMatch struct {
	Source       string                `json:"source"`
	Query        string                `json:"query"`
	Score        float64               `json:"score"`
	Mode         string                `json:"mode"`
	MatchedOn    string                `json:"matched_on"`
	EffortHint   *string               `json:"effort_hint"`
	Alternatives []EnrichedAlternative `json:"alternatives"`
}

type EnrichedAlternative struct {
	ReleaseSlug string  `json:"release_slug"`
	ReleaseName string  `json:"release_name"`
	Score       float64 `json:"score"`
	Deprecated  bool    `json:"deprecated"`
}

type EnrichedProviderMatch struct {
	GatewayProvider string         `json:"gateway_provider"`
	AAHost          string         `json:"aa_host"`
	AAHostName      string         `json:"aa_host_name"`
	Found           bool           `json:"found"`
	Rows            []EnrichedHost `json:"rows"`
	Note            string         `json:"note"`
}

type EnrichedAASummary struct {
	VariantCount           int      `json:"variant_count"`
	ScoredVariantCount     int      `json:"scored_variant_count"`
	EvalVariantCount       int      `json:"eval_variant_count"`
	CapabilityVariantCount int      `json:"capability_variant_count"`
	MaxIntelligenceIndex   *float64 `json:"max_intelligence_index"`
	MaxIntelligenceVariant string   `json:"max_intelligence_variant"`
	AvailableHosts         []string `json:"available_hosts"`
	PrimaryHasEvals        bool     `json:"primary_has_evals"`
	PrimaryHasCapabilities bool     `json:"primary_has_capabilities"`
}

type EnrichedVariantSummary struct {
	Slug              string               `json:"slug"`
	Name              string               `json:"name"`
	Suffix            string               `json:"suffix"`
	Effort            string               `json:"effort"`
	Efforts           []string             `json:"efforts"`
	IsReasoning       *bool                `json:"is_reasoning"`
	Deprecated        *bool                `json:"deprecated"`
	ChartDefault      *bool                `json:"chart_default_selected"`
	IntelligenceIndex *float64             `json:"intelligence_index"`
	Capabilities      map[string]*float64  `json:"capabilities"`
	Pricing           EnrichedSummaryPrice `json:"pricing"`
	HostCount         int                  `json:"host_count"`
}

type EnrichedSummaryPrice struct {
	InputPer1M  *float64 `json:"input_per_1m"`
	OutputPer1M *float64 `json:"output_per_1m"`
	CacheHit    *float64 `json:"cache_hit"`
	CacheWrite  *float64 `json:"cache_write"`
	Blended     *float64 `json:"blended_3_1"`
}

type EnrichedVariant struct {
	ID                           string               `json:"id"`
	Slug                         string               `json:"slug"`
	Name                         string               `json:"name"`
	ShortName                    string               `json:"shortName"`
	Suffix                       string               `json:"suffix"`
	Effort                       string               `json:"effort"`
	Efforts                      []string             `json:"efforts"`
	ChartDefaultSelected         bool                 `json:"chartDefaultSelected"`
	ReleaseDate                  *string              `json:"releaseDate"`
	IsReasoning                  bool                 `json:"isReasoning"`
	Deprecated                   bool                 `json:"deprecated"`
	IsOpenWeights                *bool                `json:"isOpenWeights"`
	ContextWindowTokens          *int                 `json:"contextWindowTokens"`
	LicenseName                  string               `json:"licenseName"`
	IntelligenceIndex            *float64             `json:"intelligenceIndex"`
	IntelligenceIndexEstimated   *bool                `json:"intelligenceIndexIsEstimated"`
	Capabilities                 map[string]*float64  `json:"capabilities"`
	Benchmarks                   EnrichedBenchmarks   `json:"-"`
	Price1mInputTokens           *float64             `json:"price1mInputTokens"`
	Price1mOutputTokens          *float64             `json:"price1mOutputTokens"`
	CacheHitPrice                *float64             `json:"cacheHitPrice"`
	CacheWritePrice              *float64             `json:"cacheWritePrice"`
	Blended0To3To1               *float64             `json:"price1mBlended0To3To1"`
	IntelligenceIndexCost        *EnrichedCost        `json:"intelligenceIndexCost"`
	IntelligenceIndexCostPerTask *EnrichedCostPerTask `json:"intelligenceIndexCostPerTask"`
	TimescaleData                *EnrichedTimescale   `json:"timescaleData"`
	OutputSpeed                  *float64             `json:"outputSpeed"`
	TimeToFirstToken             *float64             `json:"timeToFirstToken"`
	EndToEndTime                 *float64             `json:"endToEndTime"`
	EndToEndResponseTime         *EnrichedTiming      `json:"endToEndResponseTime"`
	TimeToFirstAnswerToken       *EnrichedTiming      `json:"timeToFirstAnswerToken"`
	Hosts                        []EnrichedHost       `json:"hosts"`
	InputModalityText            *bool                `json:"inputModalityText"`
	InputModalityImage           *bool                `json:"inputModalityImage"`
	InputModalitySpeech          *bool                `json:"inputModalitySpeech"`
	InputModalityVideo           *bool                `json:"inputModalityVideo"`
	OutputModalityText           *bool                `json:"outputModalityText"`
	OutputModalityImage          *bool                `json:"outputModalityImage"`
	OutputModalitySpeech         *bool                `json:"outputModalitySpeech"`
	OutputModalityVideo          *bool                `json:"outputModalityVideo"`
}

// UnmarshalJSON captures the benchmark fields, which are not modelled as a
// nested object by AA and would otherwise be ignored.
func (v *EnrichedVariant) UnmarshalJSON(data []byte) error {
	type alias EnrichedVariant
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	var b EnrichedBenchmarks
	if err := json.Unmarshal(data, &b); err != nil {
		return err
	}
	*v = EnrichedVariant(a)
	v.Benchmarks = b
	return nil
}

type EnrichedBenchmarks struct {
	SciCode                     *float64 `json:"scicode"`
	FrontierCode                *float64 `json:"frontierCode"`
	FrontierCode20              *float64 `json:"frontierCode20"`
	TerminalBench40             *float64 `json:"terminalBench40"`
	TerminalBench21             *float64 `json:"terminalBench21"`
	TerminalbenchHard           *float64 `json:"terminalbenchHard"`
	TerminalBenchScience        *float64 `json:"terminalBenchScience"`
	AutomationBenchPartialScore *float64 `json:"automationBenchPartialScore"`
	Tau2                        *float64 `json:"tau2"`
	TauBanking                  *float64 `json:"tauBanking"`
	HLE                         *float64 `json:"hle"`
	HLEDiamond                  *float64 `json:"hleDiamond"`
	GPQA                        *float64 `json:"gpqa"`
	HealthBench                 *float64 `json:"healthbench"`
	HealthBenchProfessional     *float64 `json:"healthbenchProfessional"`
	GDPval                      *float64 `json:"gdpval"`
	GDPPdfAllPass               *float64 `json:"gdpPdfAllPass"`
	CritPt                      *float64 `json:"critpt"`
	CritPtAgentic               *float64 `json:"critptAgentic"`
	CritPtAgenticHard           *float64 `json:"critptAgenticHard"`
	AnalystAgent                *float64 `json:"analystAgent"`
	MLCR                        *float64 `json:"mlcrOverall"`
	Omniscience                 *float64 `json:"omniscience"`
	LCR                         *float64 `json:"lcr"`
	AIME25                      *float64 `json:"aime25"`
	LiveCodeBench               *float64 `json:"livecodebench"`
	MMMUPro                     *float64 `json:"mmmuPro"`
	IFBench                     *float64 `json:"ifbench"`
	ITBenchSRE                  *float64 `json:"itBenchSre"`
	APEXAgents                  *float64 `json:"apexAgents"`
}

type EnrichedHost struct {
	Host                string                  `json:"host"`
	HostSlug            string                  `json:"host_slug"`
	Label               string                  `json:"label"`
	Source              string                  `json:"source"`
	HostAPIID           string                  `json:"host_api_id"`
	ContextWindowTokens *int                    `json:"context_window_tokens"`
	Pricing             EnrichedHostPricing     `json:"pricing"`
	Performance         EnrichedHostPerformance `json:"performance"`
}

type EnrichedHostPricing struct {
	Price1mInputTokens  *float64 `json:"price1mInputTokens"`
	Price1mOutputTokens *float64 `json:"price1mOutputTokens"`
	CacheHitPrice       *float64 `json:"cacheHitPrice"`
	CacheWritePrice     *float64 `json:"cacheWritePrice"`
	CostPerTask         *float64 `json:"costPerTask"`
}

type EnrichedHostPerformance struct {
	OutputSpeed                         *float64 `json:"outputSpeed"`
	TimeToFirstToken                    *float64 `json:"timeToFirstToken"`
	TimeToFirstAnswerToken              *float64 `json:"timeToFirstAnswerToken"`
	EndToEndTime                        *float64 `json:"endToEndTime"`
	MedianOutputTokensPerSecond         *float64 `json:"medianOutputTokensPerSecond"`
	MedianTimeToFirstTokenSeconds       *float64 `json:"medianTimeToFirstTokenSeconds"`
	MedianTimeToFirstAnswerTokenSeconds *float64 `json:"medianTimeToFirstAnswerTokenSeconds"`
	MedianEndToEndResponseTimeSeconds   *float64 `json:"medianEndToEndResponseTimeSeconds"`
}

type EnrichedCost struct {
	Total *float64 `json:"total"`
}

type EnrichedCostPerTask struct {
	Cost *EnrichedCost `json:"cost"`
}

type EnrichedTimescale struct {
	MedianOutputSpeed      *float64 `json:"medianOutputSpeed"`
	MedianTimeToFirstChunk *float64 `json:"medianTimeToFirstChunk"`
}

type EnrichedTiming struct {
	Total *float64 `json:"total"`
}

// AA has published both a scalar and an object with a total for these timings.
func (t *EnrichedTiming) UnmarshalJSON(data []byte) error {
	var value float64
	if err := json.Unmarshal(data, &value); err == nil {
		t.Total = &value
		return nil
	}
	type timing EnrichedTiming
	var object timing
	if err := json.Unmarshal(data, &object); err != nil {
		return err
	}
	*t = EnrichedTiming(object)
	return nil
}

// Metric describes one score the dashboard can rank by. The frontend builds
// its task selector from the snapshot's metrics list.
type Metric struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	ShortLabel  string `json:"short_label"`
	Group       string `json:"group"`
	Kind        string `json:"kind"`
	Scale       string `json:"scale"`
	Description string `json:"description"`
	Radar       bool   `json:"radar"`
	Default     bool   `json:"default"`
}

type metricSpec struct {
	Metric
	field func(EnrichedVariant) *float64
}

func capField(name string) func(EnrichedVariant) *float64 {
	return func(v EnrichedVariant) *float64 { return v.Capabilities[name] }
}

func benchField(f func(EnrichedBenchmarks) *float64) func(EnrichedVariant) *float64 {
	return func(v EnrichedVariant) *float64 { return f(v.Benchmarks) }
}

var metricSpecs = []metricSpec{
	{Metric: Metric{ID: "intelligence", Label: "General reasoning", ShortLabel: "General", Group: "Core index", Kind: "index", Scale: "index", Radar: true, Default: true, Description: "Artificial Analysis Intelligence Index v5 across knowledge work, coding, science and general reasoning."}, field: func(v EnrichedVariant) *float64 { return v.IntelligenceIndex }},
	{Metric: Metric{ID: "engineering", Label: "Engineering", ShortLabel: "Engineering", Group: "Capabilities", Kind: "capability", Scale: "index", Radar: true, Description: "Artificial Analysis engineering capability index."}, field: capField("engineering")},
	{Metric: Metric{ID: "strategy_and_ops", Label: "Strategy & Ops", ShortLabel: "Strategy", Group: "Capabilities", Kind: "capability", Scale: "index", Radar: true, Description: "Artificial Analysis strategy and operations capability index."}, field: capField("strategyAndOps")},
	{Metric: Metric{ID: "finance_and_accounting", Label: "Finance & accounting", ShortLabel: "Finance", Group: "Capabilities", Kind: "capability", Scale: "index", Radar: true, Description: "Artificial Analysis finance and accounting capability index."}, field: capField("financeAndAccounting")},
	{Metric: Metric{ID: "legal", Label: "Legal", ShortLabel: "Legal", Group: "Capabilities", Kind: "capability", Scale: "index", Radar: true, Description: "Artificial Analysis legal capability index."}, field: capField("legal")},
	{Metric: Metric{ID: "healthcare_and_medical", Label: "Healthcare & medical", ShortLabel: "Healthcare", Group: "Capabilities", Kind: "capability", Scale: "index", Radar: true, Description: "Artificial Analysis healthcare and medical capability index."}, field: capField("healthcareAndMedical")},
	{Metric: Metric{ID: "economics", Label: "Economics", ShortLabel: "Economics", Group: "Capabilities", Kind: "capability", Scale: "index", Radar: true, Description: "Artificial Analysis economics capability index."}, field: capField("economics")},
	{Metric: Metric{ID: "scicode", Label: "Coding · SciCode", ShortLabel: "SciCode", Group: "Coding", Kind: "benchmark", Scale: "percent", Description: "SciCode scientific coding benchmark. Normalized from a 0–1 pass rate to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.SciCode })},
	{Metric: Metric{ID: "terminal_bench_40", Label: "Coding · Terminal-Bench 4.0", ShortLabel: "Terminal 4.0", Group: "Coding", Kind: "benchmark", Scale: "percent", Description: "Terminal-Bench 4.0 agentic coding benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.TerminalBench40 })},
	{Metric: Metric{ID: "frontier_code", Label: "Coding · FrontierCode", ShortLabel: "FrontierCode", Group: "Coding", Kind: "benchmark", Scale: "percent", Description: "FrontierCode software engineering benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.FrontierCode })},
	{Metric: Metric{ID: "livecodebench", Label: "Coding · LiveCodeBench", ShortLabel: "LiveCodeBench", Group: "Coding", Kind: "benchmark", Scale: "percent", Description: "LiveCodeBench competitive programming benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.LiveCodeBench })},
	{Metric: Metric{ID: "automation_bench", Label: "Agentic · AutomationBench", ShortLabel: "AutomationBench", Group: "Agentic", Kind: "benchmark", Scale: "percent", Description: "AutomationBench-AA multi-step tool-use benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.AutomationBenchPartialScore })},
	{Metric: Metric{ID: "tau2", Label: "Agentic · Tau2-Bench", ShortLabel: "Tau2", Group: "Agentic", Kind: "benchmark", Scale: "percent", Description: "Tau2-Bench tool-use benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.Tau2 })},
	{Metric: Metric{ID: "terminalbench_hard", Label: "Agentic · Terminal-Bench Hard", ShortLabel: "Terminal Hard", Group: "Agentic", Kind: "benchmark", Scale: "percent", Description: "Terminal-Bench Hard agentic coding benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.TerminalbenchHard })},
	{Metric: Metric{ID: "tau_banking", Label: "Agentic · Tau-Banking", ShortLabel: "Tau-Banking", Group: "Agentic", Kind: "benchmark", Scale: "percent", Description: "Tau-Banking tool-use benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.TauBanking })},
	{Metric: Metric{ID: "hle", Label: "Reasoning · HLE", ShortLabel: "HLE", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "Humanity's Last Exam, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.HLE })},
	{Metric: Metric{ID: "hle_diamond", Label: "Reasoning · HLE Diamond", ShortLabel: "HLE Diamond", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "HLE Diamond subset, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.HLEDiamond })},
	{Metric: Metric{ID: "gpqa", Label: "Knowledge · GPQA", ShortLabel: "GPQA", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "GPQA graduate-level science questions, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.GPQA })},
	{Metric: Metric{ID: "lcr", Label: "Long context · AA-LCR", ShortLabel: "AA-LCR", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "Artificial Analysis Long Context Reasoning benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.LCR })},
	{Metric: Metric{ID: "mlcr", Label: "Long context · MLCR", ShortLabel: "MLCR", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "Multi-Lingual Context Reasoning benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.MLCR })},
	{Metric: Metric{ID: "ifbench", Label: "Instruction following · IFBench", ShortLabel: "IFBench", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "IFBench instruction-following benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.IFBench })},
	{Metric: Metric{ID: "aime25", Label: "Math · AIME 2025", ShortLabel: "AIME 2025", Group: "Reasoning & knowledge", Kind: "benchmark", Scale: "percent", Description: "AIME 2025 math benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.AIME25 })},
	{Metric: Metric{ID: "mmmu_pro", Label: "Multimodal · MMMU-Pro", ShortLabel: "MMMU-Pro", Group: "Multimodal", Kind: "benchmark", Scale: "percent", Description: "MMMU-Pro multimodal reasoning benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.MMMUPro })},
	{Metric: Metric{ID: "gdp_pdf_all_pass", Label: "Knowledge work · GDP.pdf", ShortLabel: "GDP.pdf", Group: "Knowledge work", Kind: "benchmark", Scale: "percent", Description: "GDP.pdf knowledge-work benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.GDPPdfAllPass })},
	{Metric: Metric{ID: "omniscience", Label: "Omniscience", ShortLabel: "Omniscience", Group: "Knowledge work", Kind: "index", Scale: "index", Description: "AA-Omniscience accuracy and non-hallucination index."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.Omniscience })},
	{Metric: Metric{ID: "healthbench", Label: "HealthBench", ShortLabel: "HealthBench", Group: "Healthcare", Kind: "benchmark", Scale: "percent", Description: "HealthBench clinical knowledge benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.HealthBench })},
	{Metric: Metric{ID: "terminal_bench_science", Label: "Science · Terminal-Bench Science", ShortLabel: "Terminal Science", Group: "Science", Kind: "benchmark", Scale: "percent", Description: "Terminal-Bench Science benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.TerminalBenchScience })},
	{Metric: Metric{ID: "critpt", Label: "Science · CritPt", ShortLabel: "CritPt", Group: "Science", Kind: "benchmark", Scale: "percent", Description: "CritPt physics reasoning benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.CritPt })},
	{Metric: Metric{ID: "analyst_agent", Label: "Knowledge work · AnalystAgent", ShortLabel: "AnalystAgent", Group: "Knowledge work", Kind: "benchmark", Scale: "percent", Description: "AA AnalystAgent knowledge-work benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.AnalystAgent })},
	{Metric: Metric{ID: "it_bench_sre", Label: "Operations · ITBench SRE", ShortLabel: "ITBench SRE", Group: "Operations", Kind: "benchmark", Scale: "percent", Description: "ITBench SRE operations benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.ITBenchSRE })},
	{Metric: Metric{ID: "apex_agents", Label: "Agentic · APEX Agents", ShortLabel: "APEX Agents", Group: "Agentic", Kind: "benchmark", Scale: "percent", Description: "APEX Agents benchmark, normalized to 0–100."}, field: benchField(func(b EnrichedBenchmarks) *float64 { return b.APEXAgents })},
}

// MetricSpecs returns the score definitions serialized into the snapshot.
func MetricSpecs() []Metric {
	out := make([]Metric, len(metricSpecs))
	for i, s := range metricSpecs {
		out[i] = s.Metric
	}
	return out
}

// EnrichedBuildInput bundles the enriched AA file. Gateway information (ids,
// aliases, prices, limits, upstream names) comes from the catalog rows the file
// carries; nothing is fetched from a gateway.
type EnrichedBuildInput struct {
	GeneratedAt      string
	GatewayFetchedAt string
	File             EnrichedFile
}

type enrichedAggregate struct {
	variant        EnrichedVariant
	release        EnrichedRelease
	match          EnrichedMatch
	primary        bool
	gatewayIDs     map[string]bool
	providerIDs    map[string]bool
	providerNames  map[string]bool
	aliases        map[string]bool
	upstreamModels map[string]bool
	warnings       map[string]bool
	providerMatch  EnrichedProviderMatch
	maxInput       *int
	maxOutput      *int
	rows           []EnrichedGateway
}

// BuildEnriched turns the enriched AA file plus gateway deployments into the
// dashboard snapshot. It is pure: all I/O happens in the caller.
func BuildEnriched(in EnrichedBuildInput) Snapshot {
	gwChat := 0
	for _, gr := range in.File.Rows {
		if isChatMode(gr.Mode) {
			gwChat++
		}
	}

	aggregates := map[string]*enrichedAggregate{}
	var unmatched []string
	var unmatchedDetails []UnmatchedModel
	var ambiguous []Review
	matchedRows := 0
	releaseSet := map[string]bool{}
	for _, gr := range in.File.Rows {
		if !gr.AA.Matched {
			unmatched = append(unmatched, gr.ModelID)
			closest := make([]string, 0, len(gr.AA.ClosestMatches))
			for _, c := range gr.AA.ClosestMatches {
				closest = append(closest, c.ReleaseSlug)
			}
			unmatchedDetails = append(unmatchedDetails, UnmatchedModel{
				Gateway:  gr.ModelID,
				Provider: gr.ProviderName,
				Reason:   gr.AA.Reason,
				Closest:  closest,
			})
			continue
		}
		matchedRows++
		releaseSet[gr.AA.Release.Slug] = true
		if len(gr.AA.Match.Alternatives) > 0 {
			candidates := []string{gr.AA.Release.Slug}
			for _, a := range gr.AA.Match.Alternatives {
				candidates = append(candidates, a.ReleaseSlug)
			}
			ambiguous = append(ambiguous, Review{Gateway: gr.ModelID, Candidates: candidates, Chosen: gr.AA.Release.Slug})
		}

		variants := gr.AA.Variants
		if len(variants) == 0 && gr.AA.PrimaryVariant.Slug != "" {
			variants = []EnrichedVariant{{
				Slug:                gr.AA.PrimaryVariant.Slug,
				Name:                gr.AA.PrimaryVariant.Name,
				Suffix:              gr.AA.PrimaryVariant.Suffix,
				Effort:              gr.AA.PrimaryVariant.Effort,
				Efforts:             gr.AA.PrimaryVariant.Efforts,
				IntelligenceIndex:   gr.AA.PrimaryVariant.IntelligenceIndex,
				Capabilities:        gr.AA.PrimaryVariant.Capabilities,
				Price1mInputTokens:  gr.AA.PrimaryVariant.Pricing.InputPer1M,
				Price1mOutputTokens: gr.AA.PrimaryVariant.Pricing.OutputPer1M,
				CacheHitPrice:       gr.AA.PrimaryVariant.Pricing.CacheHit,
				CacheWritePrice:     gr.AA.PrimaryVariant.Pricing.CacheWrite,
				Blended0To3To1:      gr.AA.PrimaryVariant.Pricing.Blended,
			}}
		}
		for _, v := range variants {
			a := aggregates[v.Slug]
			if a == nil {
				a = &enrichedAggregate{
					variant:        v,
					release:        gr.AA.Release,
					match:          gr.AA.Match,
					gatewayIDs:     map[string]bool{},
					providerIDs:    map[string]bool{},
					providerNames:  map[string]bool{},
					aliases:        map[string]bool{},
					upstreamModels: map[string]bool{},
					warnings:       map[string]bool{},
				}
				aggregates[v.Slug] = a
			}
			a.gatewayIDs[gr.ModelID] = true
			a.providerIDs[gr.ProviderID] = true
			a.providerNames[gr.ProviderName] = true
			a.maxInput = maxInt(a.maxInput, gr.MaxInputTokens)
			a.maxOutput = maxInt(a.maxOutput, gr.MaxOutputTokens)
			for _, alias := range gr.Aliases {
				a.aliases[alias] = true
			}
			if gr.UpstreamModel != "" {
				a.upstreamModels[gr.UpstreamModel] = true
			}
			for _, w := range gr.AA.Warnings {
				a.warnings[w] = true
			}
			if v.Slug == gr.AA.PrimaryVariantSlug {
				a.primary = true
				a.providerMatch = gr.AA.ProviderMatch
			}
			a.rows = append(a.rows, gr)
		}
	}

	rows := make([]Row, 0, len(aggregates))
	for _, a := range aggregates {
		rows = append(rows, buildEnrichedRow(a))
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Slug < rows[j].Slug })
	if rows == nil {
		rows = []Row{}
	}
	sort.Strings(unmatched)
	if unmatched == nil {
		unmatched = []string{}
	}
	if unmatchedDetails == nil {
		unmatchedDetails = []UnmatchedModel{}
	}
	sort.Slice(unmatchedDetails, func(i, j int) bool { return unmatchedDetails[i].Gateway < unmatchedDetails[j].Gateway })
	sort.Slice(ambiguous, func(i, j int) bool { return ambiguous[i].Gateway < ambiguous[j].Gateway })
	if ambiguous == nil {
		ambiguous = []Review{}
	}

	primaryWithIntel, primaryWithCaps, withIntel, deprecated := 0, 0, 0, 0
	for _, r := range rows {
		if r.Scores["intelligence"] != nil {
			withIntel++
			if r.IsPrimary {
				primaryWithIntel++
			}
		}
		if r.IsPrimary && hasAnyCapability(r.Scores) {
			primaryWithCaps++
		}
		if r.ReleaseDeprecated {
			deprecated++
		}
	}

	version, _ := strconv.ParseFloat(in.File.Source.IntelligenceIndexVersion, 64)
	generated := in.GeneratedAt
	if generated == "" {
		generated = in.File.GeneratedAt
	}
	gatewayFetched := in.GatewayFetchedAt
	if gatewayFetched == "" {
		gatewayFetched = generated
	}

	return Snapshot{
		SchemaVersion:                 SchemaVersion,
		GeneratedAt:                   generated,
		IntelligenceIndexVersion:      version,
		IntelligenceIndexVersionLabel: in.File.Source.IntelligenceIndexVersion,
		AAFetchedAt:                   in.File.Source.FetchedAt,
		GatewayFetchedAt:              gatewayFetched,
		Source: Source{
			ArtificialAnalysis: in.File.Source.Homepage,
			Gateway:            "AI Gateway",
			Attribution:        in.File.Source.Attribution,
			AAMethodology:      in.File.Source.Methodology,
			AAPages:            append([]string(nil), in.File.Source.Pages...),
			AAManifests:        manifestsOf(in.File.Source.Manifests),
		},
		Counts: Counts{
			GatewayChatModels:       gwChat,
			Matched:                 matchedRows,
			Unmatched:               len(unmatched),
			Ambiguous:               len(ambiguous),
			Rows:                    len(rows),
			CatalogRows:             len(in.File.Rows),
			Releases:                len(releaseSet),
			Variants:                len(rows),
			PrimaryWithIntelligence: primaryWithIntel,
			PrimaryWithCapabilities: primaryWithCaps,
			WithIntelligence:        withIntel,
			Deprecated:              deprecated,
		},
		Unmatched:        unmatched,
		UnmatchedDetails: unmatchedDetails,
		Ambiguous:        ambiguous,
		Metrics:          MetricSpecs(),
		Models:           rows,
	}
}

func buildEnrichedRow(a *enrichedAggregate) Row {
	gwIDs := sortedSet(a.gatewayIDs)
	providers := sortedSet(a.providerIDs)
	providerNames := sortedSet(a.providerNames)
	aliases := sortedSet(a.aliases)
	upstream := sortedSet(a.upstreamModels)
	v := a.variant

	best, gwIn, gwOut := bestCatalogRow(a.rows)
	gwProvider, gwModel := "", ""
	hostSlug := ""
	if best != nil {
		gwProvider = best.UpstreamProvider
		if gwProvider == "" {
			gwProvider = best.ProviderName
		}
		gwModel = best.ModelID
		hostSlug = best.AA.ProviderMatch.AAHost
	}

	host := findHost(v.Hosts, hostSlug)
	if host == nil && a.providerMatch.Found && len(a.providerMatch.Rows) > 0 {
		host = &a.providerMatch.Rows[0]
	}

	providerIn, providerOut := v.Price1mInputTokens, v.Price1mOutputTokens
	providerCost := (*float64)(nil)
	providerHost := ""
	if host != nil {
		if host.Pricing.Price1mInputTokens != nil {
			providerIn = host.Pricing.Price1mInputTokens
		}
		if host.Pricing.Price1mOutputTokens != nil {
			providerOut = host.Pricing.Price1mOutputTokens
		}
		providerCost = host.Pricing.CostPerTask
		providerHost = host.Host
	}

	effectiveIn, effectiveOut, priceSource := gwIn, gwOut, "gateway"
	if effectiveIn == nil || effectiveOut == nil {
		effectiveIn, effectiveOut, priceSource = providerIn, providerOut, "aa_host"
	}
	if effectiveIn == nil || effectiveOut == nil {
		effectiveIn, effectiveOut, priceSource = v.Price1mInputTokens, v.Price1mOutputTokens, "aa_model"
	}
	if effectiveIn == nil || effectiveOut == nil {
		priceSource = "none"
	}

	blended := BlendedPrice(effectiveIn, effectiveOut)
	aaBlended := BlendedPrice(v.Price1mInputTokens, v.Price1mOutputTokens)
	gwBlended := BlendedPrice(gwIn, gwOut)
	providerBlended := BlendedPrice(providerIn, providerOut)

	aaCost := variantCostPerTask(v)
	gatewayCost, costSource := estimateCostPerTask(gwIn, gwOut, providerCost, providerBlended, aaCost, aaBlended)

	perf, perfSource := variantPerformance(v, host)
	context := v.ContextWindowTokens
	gatewayContext := (*int)(nil)
	if host != nil && host.ContextWindowTokens != nil {
		gatewayContext = host.ContextWindowTokens
	} else if a.maxInput != nil {
		gatewayContext = a.maxInput
	}

	warnings := sortedSet(a.warnings)
	if a.release.Deprecated {
		warnings = appendUnique(warnings, "deprecated_release")
	}
	if v.Deprecated {
		warnings = appendUnique(warnings, "deprecated_variant")
	}
	sort.Strings(warnings)

	raw, scores := variantScores(v)
	deprecatedTo := ""
	if a.release.DeprecatedTo != nil {
		deprecatedTo = *a.release.DeprecatedTo
	}
	creator := ""
	if a.release.Creator != nil {
		creator = a.release.Creator.Name
	}

	return Row{
		Slug:                 v.Slug,
		Name:                 v.Name,
		Creator:              creator,
		ReleaseDate:          v.ReleaseDate,
		ReleaseSlug:          a.release.Slug,
		ReleaseName:          a.release.Name,
		ReleaseDeprecated:    a.release.Deprecated,
		DeprecatedTo:         deprecatedTo,
		Gateway:              gwIDs,
		GatewayProviders:     providers,
		GatewayProviderNames: providerNames,
		Aliases:              aliases,
		UpstreamModels:       upstream,
		Effort:               v.Effort,
		Efforts:              v.Efforts,
		NonReasoning:         contains(v.Efforts, "non-reasoning"),
		IsReasoning:          v.IsReasoning,
		IsPrimary:            a.primary,
		Scores:               scores,
		RawScores:            raw,
		Pricing: Pricing{
			AAInput:              v.Price1mInputTokens,
			AAOutput:             v.Price1mOutputTokens,
			GatewayInput:         gwIn,
			GatewayOutput:        gwOut,
			EffectiveInput:       effectiveIn,
			EffectiveOutput:      effectiveOut,
			BlendedUSD:           blended,
			GatewayBlendedUSD:    gwBlended,
			AABlendedUSD:         aaBlended,
			PriceSource:          priceSource,
			GatewayPriceModel:    gwModel,
			GatewayPriceProvider: gwProvider,
			PriceDiffers:         priceDiffers(gwIn, v.Price1mInputTokens) || priceDiffers(gwOut, v.Price1mOutputTokens),
			FreeAtGateway:        isZero(gwIn) && isZero(gwOut),
			AACostPerTask:        aaCost,
			GatewayCostPerTask:   gatewayCost,
			CostPerTaskSource:    costSource,
			ProviderInput:        providerIn,
			ProviderOutput:       providerOut,
			ProviderCostPerTask:  providerCost,
			ProviderHost:         providerHost,
		},
		Performance:                perf,
		PerformanceSource:          perfSource,
		ContextWindowTokens:        context,
		GatewayContextWindowTokens: gatewayContext,
		GatewayMaxOutputTokens:     a.maxOutput,
		IsOpenWeights:              v.IsOpenWeights,
		LicenseName:                v.LicenseName,
		Modalities:                 variantModalities(v),
		Hosts:                      compactHosts(v.Hosts),
		CostPerTask:                aaCost,
		ValueBlended:               ValueRatio(v.IntelligenceIndex, blended),
		ValueCostPerTask:           ValueRatio(v.IntelligenceIndex, gatewayCost),
		Warnings:                   warnings,
		Match: MatchInfo{
			Source:       a.match.Source,
			Query:        a.match.Query,
			Score:        a.match.Score,
			Mode:         a.match.Mode,
			MatchedOn:    a.match.MatchedOn,
			EffortHint:   derefString(a.match.EffortHint),
			Alternatives: alternativesOf(a.match.Alternatives),
		},
	}
}

func variantScores(v EnrichedVariant) (map[string]*float64, map[string]*float64) {
	raw := make(map[string]*float64, len(metricSpecs))
	norm := make(map[string]*float64, len(metricSpecs))
	for _, spec := range metricSpecs {
		value := spec.field(v)
		if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
			continue
		}
		raw[spec.ID] = value
		normalized := *value
		if spec.Scale == "percent" {
			normalized *= 100
		}
		norm[spec.ID] = &normalized
	}
	return raw, norm
}

func variantCostPerTask(v EnrichedVariant) *float64 {
	if v.IntelligenceIndexCostPerTask != nil && v.IntelligenceIndexCostPerTask.Cost != nil {
		return v.IntelligenceIndexCostPerTask.Cost.Total
	}
	return nil
}

func estimateCostPerTask(gwIn, gwOut *float64, providerCost, providerBlended, aaCost, aaBlended *float64) (*float64, string) {
	if gwIn == nil || gwOut == nil {
		if providerCost != nil {
			return providerCost, "aa_host"
		}
		if aaCost != nil {
			return aaCost, "aa_model"
		}
		return nil, "none"
	}
	gwBlended := BlendedPrice(gwIn, gwOut)
	if gwBlended == nil {
		return nil, "none"
	}
	if *gwBlended == 0 {
		zero := 0.0
		return &zero, "gateway_estimate"
	}
	if providerCost != nil && providerBlended != nil && *providerBlended > 0 {
		v := *providerCost * *gwBlended / *providerBlended
		return &v, "gateway_estimate"
	}
	if aaCost != nil && aaBlended != nil && *aaBlended > 0 {
		v := *aaCost * *gwBlended / *aaBlended
		return &v, "gateway_estimate"
	}
	return nil, "none"
}

func variantPerformance(v EnrichedVariant, host *EnrichedHost) (Perf, string) {
	var p Perf
	source := "aa_model"
	if host != nil {
		p.OutputTokensPerSecond = host.Performance.MedianOutputTokensPerSecond
		p.TimeToFirstToken = host.Performance.MedianTimeToFirstTokenSeconds
		p.TimeToFirstAnswer = host.Performance.MedianTimeToFirstAnswerTokenSeconds
		p.EndToEnd = host.Performance.MedianEndToEndResponseTimeSeconds
		if p.OutputTokensPerSecond == nil {
			p.OutputTokensPerSecond = host.Performance.OutputSpeed
		}
		if p.TimeToFirstToken == nil {
			p.TimeToFirstToken = host.Performance.TimeToFirstToken
		}
		if p.TimeToFirstAnswer == nil {
			p.TimeToFirstAnswer = host.Performance.TimeToFirstAnswerToken
		}
		if p.EndToEnd == nil {
			p.EndToEnd = host.Performance.EndToEndTime
		}
		if p.OutputTokensPerSecond != nil || p.TimeToFirstToken != nil || p.TimeToFirstAnswer != nil || p.EndToEnd != nil {
			source = "gateway_host"
		}
	}
	if p.OutputTokensPerSecond == nil && v.TimescaleData != nil {
		p.OutputTokensPerSecond = v.TimescaleData.MedianOutputSpeed
	}
	if p.TimeToFirstToken == nil && v.TimescaleData != nil {
		p.TimeToFirstToken = v.TimescaleData.MedianTimeToFirstChunk
	}
	if p.OutputTokensPerSecond == nil {
		p.OutputTokensPerSecond = v.OutputSpeed
	}
	if p.TimeToFirstToken == nil {
		p.TimeToFirstToken = v.TimeToFirstToken
	}
	if p.EndToEnd == nil && v.EndToEndResponseTime != nil {
		p.EndToEnd = v.EndToEndResponseTime.Total
	}
	if p.EndToEnd == nil {
		p.EndToEnd = v.EndToEndTime
	}
	if p.TimeToFirstAnswer == nil && v.TimeToFirstAnswerToken != nil {
		p.TimeToFirstAnswer = v.TimeToFirstAnswerToken.Total
	}
	return p, source
}

func variantModalities(v EnrichedVariant) Modalities {
	return Modalities{
		Input:  boolsToNames(v.InputModalityText, "text", v.InputModalityImage, "image", v.InputModalitySpeech, "audio", v.InputModalityVideo, "video"),
		Output: boolsToNames(v.OutputModalityText, "text", v.OutputModalityImage, "image", v.OutputModalitySpeech, "audio", v.OutputModalityVideo, "video"),
	}
}

func boolsToNames(flags ...any) []string {
	var out []string
	for i := 0; i+1 < len(flags); i += 2 {
		flag, ok := flags[i].(*bool)
		if ok && flag != nil && *flag {
			if name, ok := flags[i+1].(string); ok {
				out = append(out, name)
			}
		}
	}
	return out
}

func compactHosts(hosts []EnrichedHost) []Host {
	out := make([]Host, 0, len(hosts))
	seen := map[string]int{}
	for _, h := range hosts {
		key := strings.Join([]string{
			h.HostSlug,
			numKey(h.Pricing.Price1mInputTokens),
			numKey(h.Pricing.Price1mOutputTokens),
			numKey(h.Pricing.CostPerTask),
			intKey(h.ContextWindowTokens),
		}, "|")
		if idx, ok := seen[key]; ok {
			// Prefer the provider row with an API id over the aggregate long row.
			if out[idx].HostAPIID == "" && h.HostAPIID != "" {
				out[idx] = compactHost(h)
			}
			continue
		}
		seen[key] = len(out)
		out = append(out, compactHost(h))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].HostSlug != out[j].HostSlug {
			return out[i].HostSlug < out[j].HostSlug
		}
		return out[i].Label < out[j].Label
	})
	return out
}

func numKey(v *float64) string {
	if v == nil {
		return "nil"
	}
	return strconv.FormatFloat(*v, 'g', -1, 64)
}

func intKey(v *int) string {
	if v == nil {
		return "nil"
	}
	return strconv.Itoa(*v)
}

func compactHost(h EnrichedHost) Host {
	perf, _ := variantPerformance(EnrichedVariant{}, &h)
	return Host{
		Host:                  h.Host,
		HostSlug:              h.HostSlug,
		Label:                 h.Label,
		HostAPIID:             h.HostAPIID,
		InputPer1M:            h.Pricing.Price1mInputTokens,
		OutputPer1M:           h.Pricing.Price1mOutputTokens,
		CostPerTask:           h.Pricing.CostPerTask,
		ContextWindowTokens:   h.ContextWindowTokens,
		OutputTokensPerSecond: perf.OutputTokensPerSecond,
		TimeToFirstToken:      perf.TimeToFirstToken,
	}
}

func findHost(hosts []EnrichedHost, slug string) *EnrichedHost {
	if slug == "" {
		return nil
	}
	for i := range hosts {
		if hosts[i].HostSlug == slug {
			return &hosts[i]
		}
	}
	return nil
}

func isChatMode(mode string) bool {
	return mode == "chat" || mode == "responses"
}

// bestCatalogRow picks the catalog row with the lowest 3:1 blended price. Rows
// that are not chat/responses models or carry unusable prices are skipped.
func bestCatalogRow(rows []EnrichedGateway) (*EnrichedGateway, *float64, *float64) {
	var best *EnrichedGateway
	var bestIn, bestOut *float64
	bestBlend := math.Inf(1)
	for i := range rows {
		r := &rows[i]
		if !isChatMode(r.Mode) {
			continue
		}
		in, out := r.InputPer1M, r.OutputPer1M
		if in == nil || out == nil || *in < 0 || *out < 0 || math.IsNaN(*in) || math.IsNaN(*out) || math.IsInf(*in, 0) || math.IsInf(*out, 0) {
			continue
		}
		blend := (3**in + *out) / 4
		if blend < bestBlend {
			bestBlend = blend
			best = r
			bestIn, bestOut = in, out
		}
	}
	return best, bestIn, bestOut
}

func maxInt(current, next *int) *int {
	if next == nil {
		return current
	}
	if current == nil || *next > *current {
		v := *next
		return &v
	}
	return current
}

func alternativesOf(in []EnrichedAlternative) []MatchAlternative {
	out := make([]MatchAlternative, 0, len(in))
	for _, a := range in {
		out = append(out, MatchAlternative{ReleaseSlug: a.ReleaseSlug, ReleaseName: a.ReleaseName, Score: a.Score, Deprecated: a.Deprecated})
	}
	return out
}

func manifestsOf(in []EnrichedManifest) []Manifest {
	out := make([]Manifest, 0, len(in))
	for _, m := range in {
		out = append(out, Manifest{Page: m.Page, PageURL: m.PageURL, Path: m.Path, Bytes: m.Bytes, SHA256: m.SHA256, DatasetType: m.DatasetType, Count: m.Count})
	}
	return out
}

func sortedSet(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		if k != "" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func contains(in []string, value string) bool {
	for _, s := range in {
		if s == value {
			return true
		}
	}
	return false
}

func appendUnique(in []string, value string) []string {
	for _, s := range in {
		if s == value {
			return in
		}
	}
	return append(in, value)
}

func hasAnyCapability(scores Scores) bool {
	for _, key := range []string{"engineering", "strategy_and_ops", "finance_and_accounting", "legal", "healthcare_and_medical", "economics"} {
		if scores[key] != nil {
			return true
		}
	}
	return false
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
