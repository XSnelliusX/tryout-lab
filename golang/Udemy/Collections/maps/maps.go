package maps

import "fmt"

// Run demonstrates creating, reading, updating and deleting map entries.
func Run() {
	fmt.Println("--- Maps ---")
	// A map literal maps keys to values. Key order is not guaranteed.
	websites := map[string]string{
		"example.com":         "https://example.com",
		"Google":              "https://google.com",
		"Amazon Web Services": "https://aws.com",
	}
	fmt.Println("Full websites map:")
	fmt.Println(websites)

	// Reading a value by its key.
	fmt.Println("Value for key \"Google\":")
	fmt.Println(websites["Google"])

	// Adding a new key-value pair.
	websites["LinkedIn"] = "https://linkedin.com"
	fmt.Println("Map after adding \"LinkedIn\":")
	fmt.Println(websites)

	// delete removes a key-value pair.
	delete(websites, "Google")
	fmt.Println("Map after deleting \"Google\":")
	fmt.Println(websites)
}

// RunCapacity demonstrates creating a map with make to pre-allocate memory.
func RunCapacity() {
	fmt.Println("--- Map capacity with make ---")

	// An empty map literal works, but Go has to reallocate memory
	// whenever new items are added.
	courseRatings := map[string]float64{}
	courseRatings["Go"] = 4.7
	courseRatings["React"] = 4.8
	fmt.Println("courseRatings (empty literal + two entries):")
	fmt.Println(courseRatings)

	// make(map[string]float64, 3) pre-allocates memory for 3 entries,
	// so adding three items needs no reallocation. Only adding a fourth
	// makes Go allocate new memory.
	courseRatings = make(map[string]float64, 3)
	courseRatings["Go"] = 4.7
	courseRatings["React"] = 4.8
	courseRatings["Angular"] = 4.5
	fmt.Println("courseRatings (make with size 3 + three entries):")
	fmt.Println(courseRatings)
}

// floatMap is a type alias for a map with string keys and float64 values.
// The advantage: it is shorter to write, and methods can be attached to it.
type floatMap map[string]float64

// Output prints every key-value pair of the map.
func (m floatMap) Output() {
	for key, value := range m {
		fmt.Println(key, value)
	}
}

// RunAlias demonstrates using the floatMap type alias with make and a method.
func RunAlias() {
	fmt.Println("--- Map with a type alias ---")

	// make also works with the alias, because Go understands that
	// floatMap is a map[string]float64 behind the scenes.
	courseRatings := make(floatMap, 3)
	courseRatings["Go"] = 4.7
	courseRatings["React"] = 4.8
	courseRatings["Angular"] = 4.5

	// Instead of printing the whole map, call the custom method.
	fmt.Println("courseRatings via the floatMap Output method:")
	courseRatings.Output()
}

// RunLoop demonstrates the for-range loop over a map.
func RunLoop() {
	fmt.Println("--- for range over a map ---")

	courseRatings := make(floatMap, 3)
	courseRatings["Go"] = 4.7
	courseRatings["React"] = 4.8
	courseRatings["Angular"] = 4.5

	// Same syntax as for slices: range exposes two values. For a map the
	// first variable is the key (better than "index" for maps), the second
	// the value. Key order is random.
	for key, value := range courseRatings {
		fmt.Println("Key:", key, "Value:", value)
	}
}
