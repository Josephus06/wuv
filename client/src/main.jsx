import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './feed.css'
import './styles/mobile.css'
import './styles/companyThemes.css'
import { applyCompanyTheme } from './utils/activeCompany'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'

// The topbar company switcher's colours, set before the first paint.
applyCompanyTheme()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
