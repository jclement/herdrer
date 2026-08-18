package auth

import "errors"

// The authentication errors callers may distinguish. Everything a client sees
// is deliberately coarse: a caller learns that it is not authenticated, never
// why, so that probing cannot enumerate users, codes or tokens.
var (
	// ErrNoSession means no valid session cookie was presented.
	ErrNoSession = errors.New("no session")
	// ErrNoToken means no valid bearer token was presented.
	ErrNoToken = errors.New("no token")
	// ErrCeremonyMissing means the WebAuthn ceremony cookie was absent,
	// expired, or already consumed.
	ErrCeremonyMissing = errors.New("ceremony missing or expired")
	// ErrVerification means the authenticator response did not verify.
	ErrVerification = errors.New("verification failed")
	// ErrEnrollmentRequired means registration was attempted without a valid
	// single-use permit minted on the box itself.
	ErrEnrollmentRequired = errors.New("enrollment required")
)
