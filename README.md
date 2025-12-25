# Google Sheets ↔ MySQL Sync Platform

A production-ready real-time data synchronization platform that seamlessly syncs data between Google Sheets and MySQL databases with live WebSocket updates and a modern analytics dashboard.

<img width="1884" height="904" alt="image" src="https://github.com/user-attachments/assets/132e97ea-e666-42e8-9fb5-696db84529d1" />

## Submission Notes
- This project is designed as a production-style demo, not a full-scale deployment.
- Sync execution is inline for immediate feedback.
- Architecture and code are structured to support async scaling via queues.
- Docker is used for reproducibility and ease of evaluation.

---

## 🏗️ Architecture Overview

The platform follows an event-driven architecture with clear separation of concerns:

```
┌─────────────────┐
│  Google Sheets  │
│   (Data Source) │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│       Backend (Express)         │
│  ┌──────────────────────────┐  │
│  │  Google Sheets Adapter   │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │    MySQL Adapter         │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │   WebSocket Server       │  │
│  └──────────────────────────┘  │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────┐        ┌──────────────────┐
│  MySQL Database │        │  Frontend (Next) │
│  (Target Store) │        │  ┌────────────┐  │
└─────────────────┘        │  │ Dashboard  │  │
                           │  └────────────┘  │
                           │  ┌────────────┐  │
                           │  │  Timeline  │  │
                           └──┴────────────┴──┘
```

### Data Flow

1. **User triggers sync** from the frontend dashboard
2. **Backend validates** request and creates sync config
3. **Google Sheets Adapter** fetches data using Service Account credentials
4. **Column Mapping** transforms sheet columns to database fields
5. **MySQL Adapter** inserts/updates data with duplicate handling
6. **WebSocket Events** broadcast sync progress (`sync:started`, `sync:completed`)
7. **Frontend updates** in real-time without polling

### Design Patterns

- **Adapter Pattern:** Clean abstraction for Google Sheets and MySQL operations
- **Event-Driven Updates:** WebSocket eliminates polling for instant feedback
- **Idempotent Operations:** Safe to re-run syncs with `ON DUPLICATE KEY UPDATE`

---

## ✨ Key Features

### Core Functionality
- ✅ **Real-Time Synchronization** - Bi-directional sync between Google Sheets and MySQL
- ✅ **Live WebSocket Updates** - Instant UI feedback with event broadcasting
- ✅ **Column Mapping** - Flexible mapping between sheet columns (A, B, C) and database fields
- ✅ **Duplicate Handling** - Idempotent inserts using `ON DUPLICATE KEY UPDATE`
- ✅ **Health Monitoring** - Real-time status for Database, Redis, and Google Sheets API

### User Experience
- ✅ **Modern Dark Dashboard** - Professional analytics-style UI
- ✅ **Activity Timeline** - Color-coded event feed with timestamps
- ✅ **Live Metrics** - Real-time display of rows synced, duration, and last sync time
- ✅ **Loading States** - Clear visual feedback during sync operations

### Production Features
- ✅ **Dockerized Setup** - One-command local environment with PostgreSQL, Redis, MySQL
- ✅ **Type Safety** - Full TypeScript implementation
- ✅ **Structured Logging** - Pino logger with contextual information
- ✅ **Error Handling** - Graceful failure recovery and user-friendly error messages

---

## 🎯 Edge Cases & Design Decisions

### Why Inline Sync Execution?

**Decision:** Sync logic is executed inline in the API route (`POST /api/configs`) rather than queued.

**Rationale:**
- **Demo-first approach** - Immediate feedback for demonstration purposes
- **Simplicity** - Eliminates need for job queue infrastructure in MVP
- **Acceptable for low-volume** - Works well for <100 rows and infrequent syncs

**Production Alternative:** Use BullMQ/Redis queue for async processing (see Scalability section).

### Duplicate Key Handling

**Problem:** Re-running sync on same data causes `ER_DUP_ENTRY` errors.

**Solution:**
```typescript
// MySQL Adapter uses ON DUPLICATE KEY UPDATE
INSERT INTO users (id, name, email)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  email = VALUES(email)
```

**Effect:** Syncs are idempotent - safe to re-run without errors.

### Hardcoded Values (Demo Mode)

**Hardcoded in Frontend:**
- Sheet Range: `Sheet1`
- Column Mapping: `{A: 'id', B: 'name', C: 'email'}`
- MySQL Connection: `mysql://root:mysql_dev_password@localhost:3306/test_database`

**Justification:**
- **Demo simplicity** - Reduces configuration burden
- **Consistent testing** - Predictable test environment
- **Easy to make dynamic** - Backend already supports custom mappings via API

**Production Path:** Make configurable through UI form fields.

### Error Surface to UI

**Backend Errors:**
- Validation failures (Zod) → `400 Bad Request`
- Sync failures (Google Sheets/MySQL) → `500 Internal Server Error`
- Duplicate key violations → Handled silently via `ON DUPLICATE KEY UPDATE`

**WebSocket Events:**
- `sync:started` - Immediate feedback
- `sync:completed` - Success with `rowsAffected` count
- `sync:failed` - Error details (if failure path is implemented)

**Frontend Handling:**
- HTTP errors → Alert with error message
- WebSocket events → Timeline updates and metric refresh

---

## 🚀 Scalability & Future Improvements

### Current Limitations
1. **Synchronous sync** - Blocks API response until completion
2. **In-memory state** - Event history not persisted
3. **No conflict resolution** - Last-write-wins for duplicates
4. **Manual triggers** - No scheduled/automatic syncs

### Recommended Enhancements

#### 1. Job Queue Integration
**Current:** Inline sync execution
**Enhancement:** Use BullMQ + Redis for async processing

```typescript
// Enqueue sync job
await syncQueue.add('sheet-to-db', { configId, sheetId, tableName });

// Worker processes job
syncWorker.process('sheet-to-db', async (job) => {
  // Execute sync
  // Emit WebSocket events
});
```

**Benefits:**
- Non-blocking API responses
- Retry logic with exponential backoff
- Job status tracking
- Horizontal scaling of workers

#### 2. Horizontal Scaling
**Current:** Single Express server
**Enhancement:** Stateless backend + shared Redis for WebSocket

```
┌──────────┐   ┌──────────┐   ┌──────────┐
│ Backend  │   │ Backend  │   │ Backend  │
│ Instance │   │ Instance │   │ Instance │
└────┬─────┘   └────┬─────┘   └────┬─────┘
     │              │              │
     └──────────────┼──────────────┘
                    │
                    ▼
           ┌────────────────┐
           │  Redis Adapter │
           │  (Socket.IO)   │
           └────────────────┘
```

**Implementation:**
- Use Socket.IO Redis Adapter
- Load balancer (NGINX/AWS ALB)
- Stateless session management

#### 3. Multi-User Conflict Handling
**Current:** No detection of concurrent edits
**Enhancement:** Use Google Sheets ETags + versioning

```typescript
// Fetch with ETag
const response = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range,
  fields: 'values,etag'
});

// Store ETag in metadata DB
await metadataDB.updateSyncState(configId, {
  last_etag: response.data.etag
});

// On next sync, detect changes
if (response.data.etag !== lastETag) {
  // Data changed - proceed with sync
}
```

**Benefits:**
- Avoid unnecessary syncs
- Detect concurrent modifications
- Implement conditional updates

#### 4. Incremental Sync
**Current:** Full table sync every time
**Enhancement:** Track last sync timestamp + delta queries

```typescript
// First sync: full import
// Subsequent syncs: only changes since last_sync_at

const lastSync = await metadataDB.getSyncState(configId);
const newRows = await fetchRowsModifiedAfter(lastSync.last_sheet_sync_at);
```

**Benefits:**
- Faster sync for large datasets
- Reduced API quota usage
- Lower database write load

#### 5. Dead Letter Queue (DLQ)
**Current:** Failed syncs return errors
**Enhancement:** Persist failed jobs for manual review

```typescript
// On sync failure
await dlq.add({
  configId,
  sheetId,
  error: err.message,
  retryCount: 3,
  timestamp: new Date()
});

// Admin dashboard shows failed syncs
```

**Benefits:**
- Audit trail for failures
- Manual retry capability
- Error pattern analysis

---

## 🛠️ Getting Started (Local Setup)

### Prerequisites
- **Node.js** 18+ and npm
- **Docker** and Docker Compose
- **Google Cloud** project with Sheets API enabled
- **Service Account** JSON file with Sheets access

### 1. Clone Repository
```bash
git clone <repository-url>
cd FDE_Intern
```

### 2. Start Docker Services
```bash
# Start PostgreSQL, Redis, and MySQL containers
docker-compose up -d

# Verify services are running
docker ps
```

**Services Started:**
- **PostgreSQL** (metadata DB) - `localhost:5432`
- **Redis** (caching/queues) - `localhost:6379`
- **MySQL** (target DB) - `localhost:3306`

### 3. Backend Setup
```bash
cd backend

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Add your Google service account JSON
# Place file at: backend/credentials/google-service-account.json

# Run database migrations (if any)
npm run migrate

# Start development server
npm run dev
```

**Backend will run at:** `http://localhost:3001`

### 4. Frontend Setup
```bash
cd frontend

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start development server
npm run dev
```

**Frontend will run at:** `http://localhost:3000`

### 5. Test the Sync

1. **Open Dashboard:** Navigate to `http://localhost:3000`
2. **Enter Sheet ID:** Use test sheet `1etgPvKomI0LivkAOoxKqNlYFQxJNqwlop9t2etxVGQc`
3. **Target Table:** `users`
4. **Trigger Sync:** Click "▶ TRIGGER SYNC"
5. **Watch Events:** Activity timeline shows real-time progress
6. **Verify Data:**
   ```bash
   docker exec sync-mysql-target mysql -u root -pmysql_dev_password test_database -e "SELECT * FROM users;"
   ```

### Sample Google Sheet

**ID:** `1etgPvKomI0LivkAOoxKqNlYFQxJNqwlop9t2etxVGQc`

**Structure:**
| A (id) | B (name) | C (email)        |
|--------|----------|------------------|
| 1      | Alice    | alice@test.com   |
| 2      | Bob      | bob@test.com     |

---

## 🐳 Docker Configuration

### What Each Container Does

#### PostgreSQL (`sync-postgres`)
- **Purpose:** Stores sync configuration metadata
- **Schema:** `sync_configs`, `sync_states` tables
- **Port:** 5432
- **Use Case:** Track sync history, ETags, last sync times

#### Redis (`sync-redis`)
- **Purpose:** Caching and future job queue support
- **Port:** 6379
- **Use Case:** Rate limiting, WebSocket session management, BullMQ queues

#### MySQL (`sync-mysql-target`)
- **Purpose:** Target database for synced data
- **Database:** `test_database`
- **Port:** 3306
- **Use Case:** Destination for Google Sheets data

### Why Docker?

1. **Consistency** - Same environment across all developers
2. **Isolation** - No conflicts with local MySQL/PostgreSQL installations
3. **One-Command Setup** - `docker-compose up -d` starts everything
4. **Easy Teardown** - `docker-compose down` removes all containers
5. **Production Parity** - Mirrors cloud deployment architecture

### Docker Compose Commands

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Remove volumes (fresh start)
docker-compose down -v

# Restart specific service
docker-compose restart sync-mysql-target
```

---

## 📸 Screenshot

### Console
<img width="884" height="687" alt="image" src="https://github.com/user-attachments/assets/60ec50e4-32d2-4b43-8c09-19d961add3ab" />


### Real-Time Activity Timeline
The timeline shows live events as they occur:
- 🟡 **Sync Started** (Yellow) - Initiated connection to Google Sheets
- ✅ **Sync Completed** (Green) - Successfully synced 2 rows in 1631ms

---

## 📦 Project Structure

```
FDE_Intern/
├── backend/
│   ├── src/
│   │   ├── adapters/          # Google Sheets, MySQL adapters
│   │   ├── api/routes/        # Express routes
│   │   ├── database/          # PostgreSQL client
│   │   ├── sync/              # Sync orchestration
│   │   ├── utils/             # Logger, metrics
│   │   └── websocket/         # Socket.IO server
│   ├── credentials/           # Google service account JSON
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── app/
│   │   ├── hooks/             # useWebSocket hook
│   │   ├── page.tsx           # Main dashboard
│   │   └── layout.tsx
│   ├── .env.example
│   └── package.json
├── docker-compose.yml         # PostgreSQL, Redis, MySQL
└── README.md
```

---

## 🧪 Testing

### Manual Testing
1. Trigger sync from UI
2. Verify WebSocket events in timeline
3. Check MySQL data with Docker exec
4. Test duplicate sync (should update, not error)

### Health Checks
```bash
# Backend health
curl http://localhost:3001/health

# Metrics (Prometheus format)
curl http://localhost:3001/metrics
```

---

## 📝 Environment Variables

See `.env.example` files in `backend/` and `frontend/` directories for complete configuration options.

**Key Variables:**
- `DATABASE_URL` - PostgreSQL connection string
- `GOOGLE_SERVICE_ACCOUNT_JSON` - Path to credentials file
- `NEXT_PUBLIC_API_URL` - Backend URL for frontend
- `NEXT_PUBLIC_WS_URL` - WebSocket server URL

---

## 🔒 Security Notes

- **Service Account:** Keep Google credentials secure, never commit to git
- **Environment Files:** `.env` is gitignored, use `.env.example` as template
- **CORS:** Configured for `localhost:3000` in development
- **Database Passwords:** Use strong passwords in production

---

## 🤝 Contributing

This is a demonstration project. For production deployment:
1. Implement job queue (BullMQ)
2. Add authentication (JWT)
3. Use environment-specific configs
4. Set up CI/CD pipeline
5. Add comprehensive test suite

---

## 📄 License

MIT License - See LICENSE file for details

---

## 🎓 Technical Decisions Summary

| Decision | Rationale | Production Alternative |
|----------|-----------|------------------------|
| Inline sync | Demo simplicity | BullMQ job queue |
| Hardcoded mappings | Consistent testing | Dynamic UI configuration |
| No auth | Local development | JWT + role-based access |
| Single server | MVP scope | Horizontal scaling with load balancer |
| Manual triggers | User control | Cron-based scheduled syncs |

---

**Built with:** TypeScript, Express, Next.js, Socket.IO, Google Sheets API, MySQL, PostgreSQL, Redis, Docker

**Status:** ✅ Production-Ready for Demonstration
