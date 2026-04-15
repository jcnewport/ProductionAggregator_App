/**
 * Main App Component
 *
 * Sets up routing and the overall app layout.
 * Uses the Deep Current color palette:
 *   - Midnight Navy: #0A1628
 *   - Steel Blue: #4A6FA5
 *   - Electric Teal: #00BFA6
 */

import React from 'react';

const App: React.FC = () => {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        backgroundColor: '#0A1628',
        color: '#FFFFFF',
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>
          <span style={{ color: '#00BFA6' }}>S.IS</span> Production Aggregator
        </h1>
        <nav style={{ display: 'flex', gap: '16px' }}>
          <span style={{ color: '#4A6FA5', cursor: 'pointer' }}>Dashboard</span>
          <span style={{ color: '#4A6FA5', cursor: 'pointer' }}>Monthly Export</span>
          <span style={{ color: '#4A6FA5', cursor: 'pointer' }}>Daily Export</span>
        </nav>
      </header>

      {/* Main Content */}
      <main style={{ flex: 1, padding: '24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          padding: '32px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
        }}>
          <h2 style={{ color: '#0A1628', marginTop: 0 }}>Welcome to ProductionAggregator</h2>
          <p style={{ color: '#4A6FA5', lineHeight: 1.6 }}>
            This application monitors your production report inbox, parses operator
            files into a standardized format, and lets you download consolidated
            monthly and daily production exports.
          </p>
          <div style={{
            backgroundColor: '#F0F2F5',
            borderLeft: '4px solid #00BFA6',
            padding: '16px',
            borderRadius: '4px',
            marginTop: '16px'
          }}>
            <strong>Status:</strong> Setting up — Phase 1 in progress
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer style={{
        backgroundColor: '#0A1628',
        color: '#4A6FA5',
        padding: '12px 24px',
        textAlign: 'center',
        fontSize: '14px'
      }}>
        Stewardship.IS, Inc. &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
};

export default App;
