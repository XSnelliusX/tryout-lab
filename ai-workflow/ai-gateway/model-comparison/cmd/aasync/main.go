// Command aasync joins the enriched Artificial Analysis file written by
// parse_aa.mjs with the gateway catalog rows it carries, and writes the data
// file the dashboard loads.
//
//	aasync --enriched enriched.json --out data/models.js
//	aasync --enriched enriched.json --out data/models.json --format json
//
// It performs no network access. Gateway information (ids, aliases, prices,
// limits) comes only from the catalog rows embedded in the enriched file.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"model-comparison/internal/catalog"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "aasync:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("aasync", flag.ContinueOnError)
	enriched := fs.String("enriched", "", "path to the parse_aa.mjs enriched JSON (required)")
	out := fs.String("out", "", "output path (required)")
	format := fs.String("format", "", "js (window global script) or json; default from the --out extension")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *enriched == "" || *out == "" {
		return fmt.Errorf("--enriched and --out are required")
	}
	if *format == "" {
		*format = "js"
		if strings.HasSuffix(*out, ".json") {
			*format = "json"
		}
	}

	file, err := catalog.LoadEnrichedFile(*enriched)
	if err != nil {
		return err
	}
	snap := catalog.BuildEnriched(catalog.EnrichedBuildInput{
		GeneratedAt:      time.Now().UTC().Format(time.RFC3339),
		GatewayFetchedAt: file.Input.GeneratedAt,
		File:             file,
	})
	if len(snap.Models) == 0 {
		return fmt.Errorf("enriched data produced no dashboard rows; nothing written")
	}
	data, err := catalog.Encode(snap, *format)
	if err != nil {
		return err
	}
	if err := catalog.WriteFile(*out, data); err != nil {
		return err
	}

	c := snap.Counts
	fmt.Fprintf(stdout, "wrote %s\n", *out)
	fmt.Fprintf(stdout, "  catalog rows: %d (matched %d, unmatched %d, ambiguous %d)\n", c.CatalogRows, c.Matched, c.Unmatched, c.Ambiguous)
	fmt.Fprintf(stdout, "  AA releases: %d, dashboard variants: %d, with Intelligence Index: %d, deprecated: %d\n", c.Releases, c.Rows, c.WithIntelligence, c.Deprecated)
	return nil
}
