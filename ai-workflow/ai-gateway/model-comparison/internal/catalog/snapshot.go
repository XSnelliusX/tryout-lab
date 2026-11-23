package catalog

import "math"

// SchemaVersion is bumped whenever the snapshot JSON shape changes.
// 3: rows carry gateway_routes (explicit provider/model pairs).
const SchemaVersion = 3

// Snapshot is the file the dashboard loads.
type Snapshot struct {
	SchemaVersion                 int              `json:"schema_version"`
	GeneratedAt                   string           `json:"generated_at"`
	IntelligenceIndexVersion      float64          `json:"intelligence_index_version"`
	IntelligenceIndexVersionLabel string           `json:"intelligence_index_version_label,omitempty"`
	AAFetchedAt                   string           `json:"aa_fetched_at,omitempty"`
	GatewayFetchedAt              string           `json:"gateway_fetched_at,omitempty"`
	Source                        Source           `json:"source"`
	Counts                        Counts           `json:"counts"`
	Unmatched                     []string         `json:"unmatched_gateway_models"`
	UnmatchedDetails              []UnmatchedModel `json:"unmatched_details"`
	Ambiguous                     []Review         `json:"ambiguous_matches"`
	Metrics                       []Metric         `json:"metrics"`
	Models                        []Row            `json:"models"`
}

// Source records where the data came from.
type Source struct {
	ArtificialAnalysis string     `json:"artificial_analysis"`
	Gateway            string     `json:"gateway"`
	Attribution        string     `json:"attribution"`
	AAMethodology      string     `json:"aa_methodology,omitempty"`
	AAPages            []string   `json:"aa_pages,omitempty"`
	AAManifests        []Manifest `json:"aa_manifests,omitempty"`
}

// Manifest records one encrypted AA dataset used for the snapshot.
type Manifest struct {
	Page        string `json:"page"`
	PageURL     string `json:"page_url"`
	Path        string `json:"path"`
	Bytes       int    `json:"bytes"`
	SHA256      string `json:"sha256"`
	DatasetType string `json:"dataset_type"`
	Count       int    `json:"count"`
}

// Counts summarises how the gateway list was reconciled.
type Counts struct {
	GatewayChatModels       int `json:"gateway_chat_models"`
	Matched                 int `json:"matched"`
	Unmatched               int `json:"unmatched"`
	Ambiguous               int `json:"ambiguous"`
	Rows                    int `json:"rows"`
	CatalogRows             int `json:"catalog_rows"`
	Releases                int `json:"releases"`
	Variants                int `json:"variants"`
	PrimaryWithIntelligence int `json:"primary_with_intelligence"`
	PrimaryWithCapabilities int `json:"primary_with_capabilities"`
	WithIntelligence        int `json:"with_intelligence"`
	Deprecated              int `json:"deprecated"`
}

// Review lists a gateway model whose match needs a human decision.
type Review struct {
	Gateway    string   `json:"gateway"`
	Candidates []string `json:"candidates"`
	Chosen     string   `json:"chosen,omitempty"`
}

// UnmatchedModel records why a gateway model has no AA row.
type UnmatchedModel struct {
	Gateway  string   `json:"gateway"`
	Provider string   `json:"provider"`
	Reason   string   `json:"reason"`
	Closest  []string `json:"closest,omitempty"`
}

// Row is one dashboard entry: an AA model (or effort variant) served by the gateway.
type Row struct {
	Slug                       string     `json:"slug"`
	Name                       string     `json:"name"`
	Creator                    string     `json:"creator"`
	ReleaseDate                *string    `json:"release_date"`
	ReleaseSlug                string     `json:"release_slug,omitempty"`
	ReleaseName                string     `json:"release_name,omitempty"`
	ReleaseDeprecated          bool       `json:"release_deprecated"`
	DeprecatedTo               string     `json:"deprecated_to,omitempty"`
	Gateway                    []string   `json:"gateway_ids"`
	GatewayProviders           []string   `json:"gateway_providers,omitempty"`
	GatewayProviderNames       []string   `json:"gateway_provider_names,omitempty"`
	Aliases                    []string   `json:"aliases,omitempty"`
	UpstreamModels             []string   `json:"upstream_models,omitempty"`
	Effort                     string     `json:"effort,omitempty"`
	Efforts                    []string   `json:"efforts,omitempty"`
	NonReasoning               bool       `json:"non_reasoning"`
	IsReasoning                bool       `json:"is_reasoning"`
	IsPrimary                  bool       `json:"is_primary"`
	Scores                     Scores     `json:"scores"`
	RawScores                  Scores     `json:"raw_scores,omitempty"`
	Pricing                    Pricing    `json:"pricing"`
	Performance                Perf       `json:"performance"`
	PerformanceSource          string     `json:"performance_source,omitempty"`
	ContextWindowTokens        *int       `json:"context_window_tokens,omitempty"`
	GatewayContextWindowTokens *int       `json:"gateway_context_window_tokens,omitempty"`
	GatewayMaxOutputTokens     *int       `json:"gateway_max_output_tokens,omitempty"`
	IsOpenWeights              *bool      `json:"is_open_weights,omitempty"`
	LicenseName                string     `json:"license_name,omitempty"`
	Modalities                 Modalities `json:"modalities"`
	Hosts                      []Host     `json:"hosts,omitempty"`
	GatewayRoutes              []Route    `json:"gateway_routes"`
	CostPerTask                *float64   `json:"intelligence_index_cost_per_task_usd"`
	ValueBlended               *float64   `json:"value_per_blended_usd"`
	ValueCostPerTask           *float64   `json:"value_per_cost_per_task_usd"`
	Warnings                   []string   `json:"warnings,omitempty"`
	Match                      MatchInfo  `json:"match"`
}

// MatchInfo records how a gateway row was linked to an AA release.
type MatchInfo struct {
	Source       string             `json:"source"`
	Query        string             `json:"query"`
	Score        float64            `json:"score"`
	Mode         string             `json:"mode"`
	MatchedOn    string             `json:"matched_on"`
	EffortHint   string             `json:"effort_hint,omitempty"`
	Alternatives []MatchAlternative `json:"alternatives,omitempty"`
}

type MatchAlternative struct {
	ReleaseSlug string  `json:"release_slug"`
	ReleaseName string  `json:"release_name"`
	Score       float64 `json:"score"`
	Deprecated  bool    `json:"deprecated"`
}

// Scores is a metric-id -> value map. Null means not measured.
type Scores map[string]*float64

// Pricing holds AA prices per 1M tokens, the gateway's own prices, and the
// effective price used for value calculations.
type Pricing struct {
	AAInput              *float64 `json:"aa_input_per_1m"`
	AAOutput             *float64 `json:"aa_output_per_1m"`
	GatewayInput         *float64 `json:"gateway_input_per_1m"`
	GatewayOutput        *float64 `json:"gateway_output_per_1m"`
	EffectiveInput       *float64 `json:"effective_input_per_1m"`
	EffectiveOutput      *float64 `json:"effective_output_per_1m"`
	BlendedUSD           *float64 `json:"blended_3_to_1_per_1m"`
	GatewayBlendedUSD    *float64 `json:"gateway_blended_3_to_1_per_1m"`
	AABlendedUSD         *float64 `json:"aa_blended_3_to_1_per_1m"`
	PriceSource          string   `json:"price_source"`
	GatewayPriceModel    string   `json:"gateway_price_model,omitempty"`
	GatewayPriceProvider string   `json:"gateway_price_provider,omitempty"`
	PriceDiffers         bool     `json:"gateway_price_differs_from_aa"`
	FreeAtGateway        bool     `json:"free_at_gateway"`
	AACostPerTask        *float64 `json:"aa_cost_per_task_usd"`
	GatewayCostPerTask   *float64 `json:"gateway_cost_per_task_usd"`
	CostPerTaskSource    string   `json:"cost_per_task_source"`
	ProviderInput        *float64 `json:"provider_input_per_1m"`
	ProviderOutput       *float64 `json:"provider_output_per_1m"`
	ProviderCostPerTask  *float64 `json:"provider_cost_per_task_usd"`
	ProviderHost         string   `json:"provider_host,omitempty"`
}

// Perf holds median serving metrics.
type Perf struct {
	OutputTokensPerSecond *float64 `json:"output_tokens_per_second"`
	TimeToFirstToken      *float64 `json:"time_to_first_token_seconds"`
	TimeToFirstAnswer     *float64 `json:"time_to_first_answer_token_seconds"`
	EndToEnd              *float64 `json:"end_to_end_seconds"`
}

// Modalities lists the input and output modalities.
type Modalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// Route is one gateway deployment serving a variant: an explicit provider id
// and model id, with that deployment's own prices and cost per task.
type Route struct {
	ProviderID            string   `json:"provider_id"`
	ProviderName          string   `json:"provider_name,omitempty"`
	ModelID               string   `json:"model_id"`
	InputPer1M            *float64 `json:"input_per_1m"`
	OutputPer1M           *float64 `json:"output_per_1m"`
	BlendedUSD            *float64 `json:"blended_3_to_1_per_1m"`
	CostPerTask           *float64 `json:"cost_per_task_usd"`
	CostPerTaskSource     string   `json:"cost_per_task_source"`
	EffortLevels          []string `json:"effort_levels"`
	Tools                 *bool    `json:"tools,omitempty"`
	MaxInputTokens        *int     `json:"max_input_tokens,omitempty"`
	MaxOutputTokens       *int     `json:"max_output_tokens,omitempty"`
	OutputTokensPerSecond *float64 `json:"output_tokens_per_second"`
}

// Host is one provider-specific AA row for a variant.
type Host struct {
	Host                  string   `json:"host"`
	HostSlug              string   `json:"host_slug"`
	Label                 string   `json:"label,omitempty"`
	HostAPIID             string   `json:"host_api_id,omitempty"`
	InputPer1M            *float64 `json:"input_per_1m"`
	OutputPer1M           *float64 `json:"output_per_1m"`
	CostPerTask           *float64 `json:"cost_per_task_usd"`
	ContextWindowTokens   *int     `json:"context_window_tokens,omitempty"`
	OutputTokensPerSecond *float64 `json:"output_tokens_per_second"`
	TimeToFirstToken      *float64 `json:"time_to_first_token_seconds"`
}

// BlendedPrice is AA's 3:1 input:output blend, (3 x input + output) / 4.
func BlendedPrice(input, output *float64) *float64 {
	if input == nil || output == nil {
		return nil
	}
	v := (3**input + *output) / 4
	return &v
}

// ValueRatio is score divided by price. It is null when the score or price is
// missing or the price is zero, since a zero price would give an infinite ratio.
func ValueRatio(score, price *float64) *float64 {
	if score == nil || price == nil || *price <= 0 {
		return nil
	}
	v := *score / *price
	return &v
}

func isZero(v *float64) bool {
	return v != nil && *v == 0
}

func priceDiffers(gw, aaPrice *float64) bool {
	if gw == nil || aaPrice == nil {
		return false
	}
	return math.Abs(*gw-*aaPrice) > 0.01*math.Max(*aaPrice, 1e-9)
}
