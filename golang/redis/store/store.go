package store

type Store struct {
	ValueMap map[string]string
}

func (s *Store) Set(key string, value string) {
	s.ValueMap[key] = value
}

func (s *Store) Get(key string) (string, bool) {
	val, exists := s.ValueMap[key]
	return val, exists
}

func NewStore() *Store {
	return &Store{
		ValueMap: make(map[string]string),
	}
}
