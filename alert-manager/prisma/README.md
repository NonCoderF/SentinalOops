# PostgreSQL persistence contract

The Prisma schema is the PostgreSQL replacement for the current SQLite data-access layer. The active Phase 3 runtime remains SQLite-compatible until the API and both workers are switched together; this avoids breaking the existing stack during migration. Generate and validate the client with:

```powershell
npx prisma validate --schema alert-manager/prisma/schema.prisma
```
