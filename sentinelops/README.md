# SentinelOps application

This directory contains the deployable monitoring product: the Fastify backend, React/Vite frontend, alert receiver, and optional recovery controller. It has no dependency on the demo test service and starts with zero registered endpoints.

The installer builds `sentinelops/Dockerfile` and persists SQLite in the installer-managed `sentinelops_data` volume.
