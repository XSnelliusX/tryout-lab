package report

import (
	"concurrency/filemanager"
	"fmt"
	"strconv"
	"strings"
)

// regionJob holds the sales amounts of one region.
type regionJob struct {
	region  string
	amounts []float64
}

// Process writes the report for one region. A go call discards return values,
// so the outcome goes through channels: an error into errChan, or true into
// doneChan once the report is written.
func (job regionJob) Process(doneChan chan bool, errChan chan error) {
	lines := []string{"Region: " + job.region}
	total := 0.0
	for _, amount := range job.amounts {
		if amount < 0 {
			errChan <- fmt.Errorf("region %s has a negative amount: %.2f", job.region, amount)
			return
		}
		total += amount
		lines = append(lines, fmt.Sprintf("%.2f", amount))
	}
	lines = append(lines, fmt.Sprintf("Total: %.2f", total))

	if err := filemanager.WriteResult("report_"+job.region+".txt", lines); err != nil {
		errChan <- err
		return
	}

	doneChan <- true
}

// Run builds one report per region. Each region runs in its own goroutine.
func Run(inputPath string) error {
	jobs, err := readJobs(inputPath)
	if err != nil {
		return err
	}

	// Each goroutine gets its own channels. The buffer of 1 lets a goroutine
	// send its single result even before Run reaches that region.
	doneChans := make([]chan bool, len(jobs))
	errChans := make([]chan error, len(jobs))

	for i, job := range jobs {
		doneChans[i] = make(chan bool, 1)
		errChans[i] = make(chan error, 1)
		go job.Process(doneChans[i], errChans[i])
	}

	// select waits for a ready channel. The loop runs in index order,
	// so an error is only seen once every earlier region has finished.
	// Keep the first error, but wait for every job before returning.
	var firstErr error
	for i, job := range jobs {
		select {
		case err := <-errChans[i]:
			if firstErr == nil {
				firstErr = err
			}
		case <-doneChans[i]:
			fmt.Println("Report written for", job.region)
		}
	}

	return firstErr
}

// readJobs reads "region,amount" lines and groups the amounts by region,
// in the order the regions first appear.
func readJobs(path string) ([]regionJob, error) {
	lines, err := filemanager.ReadLines(path)
	if err != nil {
		return nil, err
	}

	var jobs []regionJob
	indexOf := make(map[string]int)
	for _, line := range lines {
		parts := strings.Split(line, ",")
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid line %q", line)
		}

		region := strings.TrimSpace(parts[0])
		amount, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		if err != nil {
			return nil, fmt.Errorf("invalid amount in %q: %w", line, err)
		}

		i, found := indexOf[region]
		if !found {
			i = len(jobs)
			indexOf[region] = i
			jobs = append(jobs, regionJob{region: region})
		}
		jobs[i].amounts = append(jobs[i].amounts, amount)
	}
	return jobs, nil
}
