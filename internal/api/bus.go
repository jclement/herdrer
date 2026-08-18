package api

import "sync"

// Bus fans realtime events out to a user's connected browsers.
//
// Per-user, never global: an event is delivered only to sockets authenticated
// as the user it concerns. Sends are non-blocking, because one wedged phone
// must not stall an answer that another device is waiting on.
type Bus struct {
	mu   sync.Mutex
	subs map[string]map[chan any]struct{}
}

// NewBus builds an empty bus.
func NewBus() *Bus {
	return &Bus{subs: map[string]map[chan any]struct{}{}}
}

// Subscribe registers a listener for one user's events.
func (b *Bus) Subscribe(userID string) (<-chan any, func()) {
	ch := make(chan any, 32)
	b.mu.Lock()
	if b.subs[userID] == nil {
		b.subs[userID] = map[chan any]struct{}{}
	}
	b.subs[userID][ch] = struct{}{}
	b.mu.Unlock()

	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if set, ok := b.subs[userID]; ok {
			if _, present := set[ch]; present {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(b.subs, userID)
			}
		}
	}
}

// Publish delivers an event to every socket belonging to a user.
func (b *Bus) Publish(userID string, event any) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs[userID] {
		select {
		case ch <- event:
		default:
		}
	}
}
