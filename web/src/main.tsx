import { createRoot } from 'react-dom/client'
import App from './App'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './styles/theme.css'

// Note: no React.StrictMode — its double-mount would create two WebGL Cesium
// contexts on boot for no benefit at this app's scale.
createRoot(document.getElementById('root')!).render(<App />)
