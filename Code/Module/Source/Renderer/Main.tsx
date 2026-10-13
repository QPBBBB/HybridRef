import React from 'react'
import { createRoot as CreateRoot } from 'react-dom/client'
import App from './App'
import FileDialog from './FileDialog'
import { CreateBrowserApi } from './BrowserApi'
import './Style.css'

window.HybridRef = CreateBrowserApi()
CreateRoot(document.getElementById('root')!).render(<><App /><FileDialog /></>)
