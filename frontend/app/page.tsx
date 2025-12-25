'use client';

import { useEffect, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';

export default function Home() {
  const { isConnected, healthStatus, events } = useWebSocket();

  const [sheetId, setSheetId] = useState('');
  const [tableName, setTableName] = useState('users');
  const [isSyncing, setIsSyncing] = useState(false);

  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [rowsAffected, setRowsAffected] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const startedEvent = events.find((e) => e.type === 'sync:started');
    const completedEvent = events.find((e) => e.type === 'sync:completed');

    if (startedEvent && !completedEvent) {
      setIsSyncing(true);
    }

    if (completedEvent) {
      setIsSyncing(false);
      setLastSyncTime(new Date());
      setRowsAffected(completedEvent.data.rowsAffected || 0);
      setDuration(completedEvent.data.duration || 0);
    }
  }, [events]);

  const handleTriggerSync = async () => {
    if (!sheetId.trim() || isSyncing) return;

    setIsSyncing(true);
    try {
      const res = await fetch('http://localhost:3001/api/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Quick Sync',
          sheet_id: sheetId,
          sheet_range: 'Sheet1',
          db_connection_string: 'mysql://root:mysql_dev_password@localhost:3306/test_database',
          db_table_name: tableName,
          column_mapping: { A: 'id', B: 'name', C: 'email' },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setIsSyncing(false);
      }
    } catch (error) {
      setIsSyncing(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0e1117',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#fff'
    }}>

      {/* Header */}
      <div style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(11,15,20,0.8)',
        backdropFilter: 'blur(12px)',
        position: 'sticky',
        top: 0,
        zIndex: 50
      }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '24px 32px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Sync Platform Dashboard
          </h1>
          <p style={{ fontSize: '14px', color: '#8b92a7', margin: '4px 0 0 0' }}>
            Google Sheets ↔ MySQL Real-Time Sync
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '32px' }}>

        {/* Status Cards Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '20px',
          marginBottom: '32px'
        }}>
          <StatusCard
            icon="🔌"
            label="WebSocket"
            value={isConnected ? 'Connected' : 'Offline'}
            isHealthy={isConnected}
          />
          <StatusCard
            icon="💾"
            label="Database"
            value={healthStatus?.database || 'Unknown'}
            isHealthy={healthStatus?.database === 'healthy'}
          />
          <StatusCard
            icon="📊"
            label="Google Sheets"
            value={healthStatus?.googleSheets || 'Unknown'}
            isHealthy={healthStatus?.googleSheets === 'healthy'}
          />
        </div>

        {/* Main Grid Layout */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr',
          gap: '24px',
          marginBottom: '32px'
        }}>

          {/* Left Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Sync Configuration Card */}
            <div style={{
              background: '#141922',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '16px',
              padding: '28px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.3)'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '24px'
              }}>
                <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>
                  Sync Configuration
                </h2>
                {isSyncing && (
                  <span style={{
                    fontSize: '13px',
                    color: '#fbbf24',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <span style={{
                      width: '8px',
                      height: '8px',
                      background: '#fbbf24',
                      borderRadius: '50%',
                      animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
                    }} />
                    Processing
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div>
                  <label style={{
                    display: 'block',
                    fontSize: '12px',
                    fontWeight: 500,
                    color: '#8b92a7',
                    marginBottom: '8px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    Google Sheet ID
                  </label>
                  <input
                    type="text"
                    value={sheetId}
                    onChange={(e) => setSheetId(e.target.value)}
                    placeholder="1abc...xyz"
                    disabled={isSyncing}
                    style={{
                      width: '100%',
                      background: '#0b0f14',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '10px',
                      padding: '14px 16px',
                      fontSize: '14px',
                      color: '#fff',
                      outline: 'none',
                      transition: 'all 0.2s',
                      opacity: isSyncing ? 0.5 : 1
                    }}
                  />
                </div>

                <div>
                  <label style={{
                    display: 'block',
                    fontSize: '12px',
                    fontWeight: 500,
                    color: '#8b92a7',
                    marginBottom: '8px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    Target MySQL Table
                  </label>
                  <input
                    type="text"
                    value={tableName}
                    onChange={(e) => setTableName(e.target.value)}
                    placeholder="users"
                    disabled={isSyncing}
                    style={{
                      width: '100%',
                      background: '#0b0f14',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '10px',
                      padding: '14px 16px',
                      fontSize: '14px',
                      color: '#fff',
                      outline: 'none',
                      transition: 'all 0.2s',
                      opacity: isSyncing ? 0.5 : 1
                    }}
                  />
                </div>

                <button
                  onClick={handleTriggerSync}
                  disabled={isSyncing || !sheetId.trim()}
                  style={{
                    width: '100%',
                    padding: '16px 24px',
                    background: isSyncing
                      ? 'rgba(251, 191, 36, 0.15)'
                      : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                    border: isSyncing ? '1px solid rgba(251, 191, 36, 0.3)' : 'none',
                    borderRadius: '10px',
                    fontSize: '14px',
                    fontWeight: 600,
                    color: isSyncing ? '#fbbf24' : '#fff',
                    cursor: isSyncing ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                    opacity: (!sheetId.trim() || isSyncing) ? 0.6 : 1,
                    letterSpacing: '0.5px',
                    textTransform: 'uppercase'
                  }}
                >
                  {isSyncing ? '⏳ Syncing...' : '▶ Trigger Sync'}
                </button>
              </div>
            </div>

            {/* Metrics Cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '16px'
            }}>
              <MetricCard
                icon="🕒"
                label="Last Sync"
                value={lastSyncTime ? lastSyncTime.toLocaleTimeString() : 'Never'}
                color="#8b92a7"
              />
              <MetricCard
                icon="📊"
                label="Rows Affected"
                value={rowsAffected.toString()}
                color="#10b981"
              />
              <MetricCard
                icon="⚡"
                label="Duration"
                value={duration ? `${duration}ms` : '—'}
                color="#3b82f6"
              />
            </div>
          </div>

          {/* Right Column - Activity Timeline */}
          <div>
            <div style={{
              background: '#141922',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '16px',
              padding: '28px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
              height: '100%'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '24px'
              }}>
                <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>
                  Activity Timeline
                </h2>
                <span style={{
                  fontSize: '12px',
                  color: '#8b92a7',
                  background: 'rgba(139,146,167,0.1)',
                  padding: '4px 10px',
                  borderRadius: '6px'
                }}>
                  {events.length}
                </span>
              </div>

              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                maxHeight: '600px',
                overflowY: 'auto'
              }}>
                {events.length === 0 ? (
                  <div style={{
                    textAlign: 'center',
                    padding: '60px 20px',
                    color: '#4b5563'
                  }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>
                      📡
                    </div>
                    <p style={{ fontSize: '14px', margin: 0 }}>
                      Waiting for events...
                    </p>
                  </div>
                ) : (
                  events.slice().reverse().slice(0, 20).map((event, idx) => (
                    <TimelineEvent key={idx} event={event} />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusCard({ icon, label, value, isHealthy }: {
  icon: string;
  label: string;
  value: string;
  isHealthy: boolean;
}) {
  return (
    <div style={{
      background: '#141922',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '14px',
      padding: '20px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.2)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
        <span style={{ fontSize: '24px' }}>{icon}</span>
        <span style={{
          fontSize: '12px',
          fontWeight: 500,
          color: '#8b92a7',
          textTransform: 'uppercase',
          letterSpacing: '0.5px'
        }}>
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: isHealthy ? '#10b981' : '#ef4444'
        }} />
        <span style={{
          fontSize: '14px',
          fontWeight: 600,
          color: isHealthy ? '#10b981' : '#ef4444'
        }}>
          {value}
        </span>
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value, color }: {
  icon: string;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div style={{
      background: '#141922',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '12px',
      padding: '20px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.2)'
    }}>
      <span style={{ fontSize: '20px', display: 'block', marginBottom: '8px' }}>
        {icon}
      </span>
      <p style={{
        fontSize: '11px',
        fontWeight: 500,
        color: '#8b92a7',
        margin: '0 0 8px 0',
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '24px',
        fontWeight: 700,
        color: color,
        margin: 0
      }}>
        {value}
      </p>
    </div>
  );
}

function TimelineEvent({ event }: { event: { type: string; data: any } }) {
  const getEventStyle = (type: string) => {
    if (type.includes('started')) return {
      icon: '🟡',
      label: 'Sync Started',
      color: '#fbbf24',
      bg: 'rgba(251, 191, 36, 0.08)',
      border: 'rgba(251, 191, 36, 0.2)'
    };
    if (type.includes('completed')) return {
      icon: '✅',
      label: 'Sync Completed',
      color: '#10b981',
      bg: 'rgba(16, 185, 129, 0.08)',
      border: 'rgba(16, 185, 129, 0.2)'
    };
    if (type.includes('failed')) return {
      icon: '❌',
      label: 'Sync Failed',
      color: '#ef4444',
      bg: 'rgba(239, 68, 68, 0.08)',
      border: 'rgba(239, 68, 68, 0.2)'
    };
    return {
      icon: '📬',
      label: type,
      color: '#3b82f6',
      bg: 'rgba(59, 130, 246, 0.08)',
      border: 'rgba(59, 130, 246, 0.2)'
    };
  };

  const style = getEventStyle(event.type);

  return (
    <div style={{
      background: style.bg,
      border: `1px solid ${style.border}`,
      borderRadius: '10px',
      padding: '16px',
      transition: 'all 0.2s'
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span style={{ fontSize: '20px' }}>{style.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '4px'
          }}>
            <p style={{
              fontSize: '14px',
              fontWeight: 600,
              color: style.color,
              margin: 0
            }}>
              {style.label}
            </p>
            <span style={{
              fontSize: '11px',
              color: '#6b7280'
            }}>
              {new Date().toLocaleTimeString()}
            </span>
          </div>
          <p style={{
            fontSize: '12px',
            color: '#8b92a7',
            margin: 0
          }}>
            {event.data.direction || 'Processing'}
            {event.data.rowsAffected && ` · ${event.data.rowsAffected} rows synced`}
          </p>
        </div>
      </div>
    </div>
  );
}
