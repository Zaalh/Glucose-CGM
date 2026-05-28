import { useState } from 'react'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'
import styles from './App.module.css'

type Page = 'dashboard' | 'settings'

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
              className={`${styles.navBtn} ${page === 'settings' ? styles.active : ''}`}
              onClick={() => setPage('settings')}
            >
              Instellingen
            </button>
          </nav>
        </div>
      </header>
      <main className={styles.main}>
        {page === 'dashboard' ? <Dashboard /> : <Settings />}
      </main>
    </div>
  )
}
