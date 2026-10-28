package store

import (
	"fmt"
	"sync"
	"testing"
)

func TestSetAndGet(t *testing.T) {
	s := NewStore()

	s.Set("key", "value")
	got, exists := s.Get("key")

	if !exists {
		t.Error("key doesn't exist")
	}
	if got != "value" {
		t.Errorf("got %v, expected value", got)
	}
}

func TestGetMissingKey(t *testing.T) {
	s := NewStore()
	_, exists := s.Get("key")
	if exists {
		t.Error("key shouldn't exist")
	}
}

func TestOverwriteValue(t *testing.T) {
	s := NewStore()
	s.Set("key", "value")
	s.Set("key", "newValue")

	got, exists := s.Get("key")
	if !exists {
		t.Error("key doesn't exist")
	}
	if got != "newValue" {
		t.Errorf("got %v, expected newValue", got)
	}
}

func TestEmptyValue(t *testing.T) {
	s := NewStore()
	s.Set("key", "")
	got, exists := s.Get("key")

	if !exists {
		t.Error("key doesn't exist")
	}
	if got != "" {
		t.Errorf("got %v, expected empty string", got)
	}
}

func TestConcurrentSetAndGetDifferentKeys(t *testing.T) {
	s := NewStore()

	numWorkers := 20
	var wg sync.WaitGroup
	start := make(chan struct{})

	for i := range numWorkers {
		wg.Go(func() {
			<-start

			key := fmt.Sprintf("key-%d", i)
			value := fmt.Sprintf("value-%d", i)
			s.Set(key, value)
		})
	}

	close(start)
	wg.Wait()

	for i := range numWorkers {
		key := fmt.Sprintf("key-%d", i)
		expectedValue := fmt.Sprintf("value-%d", i)

		got, exists := s.Get(key)
		if !exists || got != expectedValue {
			t.Errorf("got %v, expected %v", got, expectedValue)
		}
	}
}

func TestConcurrentSetAndGetOneKey(t *testing.T) {
	s := NewStore()
	s.Set("key", "initialValue")

	numWorkers := 20
	resultValues := make([]string, numWorkers)
	var wg sync.WaitGroup
	start := make(chan struct{})

	for i := range numWorkers {
		wg.Go(func() {
			<-start
			value := fmt.Sprintf("value-%d", i)
			s.Set("key", value)
		})
		wg.Go(func() {
			<-start

			got, exists := s.Get("key")
			if !exists {
				t.Error("key doesn't exist")
			}
			resultValues[i] = got
		})
	}
	close(start)
	wg.Wait()

	allowed := map[string]bool{"initialValue": true}
	for i := range numWorkers {
		allowed[fmt.Sprintf("value-%d", i)] = true
	}

	for i, got := range resultValues {
		if !allowed[got] {
			t.Errorf("reader %d got unexpected value %q", i, got)
		}
	}
}
