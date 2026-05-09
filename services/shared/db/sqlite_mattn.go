//go:build sqlite_mattn

package db

import (
	"context"
	"database/sql"

	_ "github.com/mattn/go-sqlite3"
)

func init() {
	RegisterDBOpener("sqlite3", func(_ context.Context, dsn string) (*sql.DB, error) {
		return sql.Open("sqlite3", dsn)
	})
}
