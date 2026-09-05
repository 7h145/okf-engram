---
type: Decision
title: Local authorization cache policy
description: Lantern caches authorization metadata in SQLite for offline reads.
status: stable
tags:
  - lantern
  - cache
---
# Local authorization cache

Lantern uses SQLite for local authorization metadata so authorization reads can
continue through a control-plane outage. Entitlements are cached for 24 hours.

See [event delivery](/platform/event-delivery.md).
