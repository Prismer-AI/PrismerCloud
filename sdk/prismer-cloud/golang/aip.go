package prismer

// Prismer SDK — AIP Identity (Platform Integration)
//
// Go SDK re-exports from the standalone aip-sdk-go module.
// Import the standalone SDK directly for pure AIP usage:
//
//	import aip "github.com/nicepkg/aip-sdk-go"
//	id, _ := aip.NewAIPIdentity()
//
// The prismer-sdk-go module adds platform-specific wrappers (v1.7.4 planned):
//
//	import prismer "github.com/nicepkg/prismer-sdk-go"
//	agent, _ := prismer.RegisterAIPAgent(client, apiKey)

// NOTE: In Go, re-exporting from another module requires explicit type aliases.
// Until the standalone aip-sdk-go is published, the platform SDK embeds the
// implementation directly. After publishing, this file will import from
// github.com/nicepkg/aip-sdk-go and provide thin wrappers.
//
// For now, users should import the standalone SDK directly from sdk/aip/golang/.
// See sdk/aip/golang/ for the full AIP SDK implementation.
