package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
)

var (
	ErrStoreDriverNotRegistered = errors.New("store driver not registered")
	ErrStoreDSNRequired         = errors.New("store dsn required")
)

type DBOpener func(ctx context.Context, dsn string) (*sql.DB, error)

var (
	openerMu sync.RWMutex
	openers  = map[string]DBOpener{}
)

func RegisterDBOpener(driver string, opener DBOpener) {
	openerMu.Lock()
	defer openerMu.Unlock()
	openers[driver] = opener
}

func LookupDBOpener(driver string) (DBOpener, bool) {
	openerMu.RLock()
	defer openerMu.RUnlock()
	opener, ok := openers[driver]
	return opener, ok
}

func OpenSQLStore(ctx context.Context, driver string, dsn string) (*SQLStore, *sql.DB, error) {
	if dsn == "" {
		return nil, nil, ErrStoreDSNRequired
	}
	opener, ok := LookupDBOpener(driver)
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s", ErrStoreDriverNotRegistered, driver)
	}
	db, err := opener(ctx, dsn)
	if err != nil {
		return nil, nil, err
	}
	return NewSQLStore(db), db, nil
}
