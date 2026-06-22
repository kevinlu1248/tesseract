import './devApiMock' // installs a mock window.api only when no Electron preload is present
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
