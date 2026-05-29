import { Suspense, lazy, useState } from 'react'
import styles from './App.module.css'

type Page = 'dashboard' | 'nightscout' | 'settings'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Settings = lazy(() => import('./pages/Settings'))
const Nightscout = lazy(() => import('./pages/Nightscout'))

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>◎</span>
            <span className={styles.logoText}>Glucose CGM</span>
          </div>
          <nav className={styles.nav}>
            <button
              className={`${styles.navBtn} ${page === 'dashboard' ? styles.active : ''}`}
              onClick={() => setPage('dashboard')}
            >
              Dashboard
            </button>
            <button
              className={`${styles.navBtn} ${page === 'nightscout' ? styles.active : ''}`}
              onClick={() => setPage('nightscout')}
            >
              Nightscout
            </button>
            <button
              className={`${styles.navBtn} ${page === 'settings' ? styles.active : ''}`}
              onClick={() => setPage('settings')}
            >
              Instellingen
            </button>
          </nav>
        </div>
      </header>
      <main className={`${styles.main} ${page === 'nightscout' ? styles.mainDark : ''}`}>
        <Suspense fallback={<div className={styles.pageLoading}>Laden...</div>}>
          {page === 'dashboard' && <Dashboard />}
          {page === 'nightscout' && <Nightscout />}
          {page === 'settings' && <Settings />}
        </Suspense>
      </main>
    </div>
  )
}
