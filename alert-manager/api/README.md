# Alert Manager API

The production webhook implementation currently lives in `apps/alert-manager/backend` and publishes the versioned Kafka event contract in `shared/events.ts`. This workspace folder is reserved for the PostgreSQL/Prisma API migration so the existing working API remains backward compatible during Phase 3B.
