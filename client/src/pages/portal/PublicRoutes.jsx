import { Routes, Route } from 'react-router-dom';
import SharePage from './SharePage.jsx';
import PortalPage from './PortalPage.jsx';
import PayLinkPage from './PayLinkPage.jsx';
import { Notice } from './PublicShell.jsx';

// Rendered outside the auth gate for /share/* and /portal/* (see App.jsx).
export default function PublicRoutes() {
  return (
    <Routes>
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="/portal/pay/:token" element={<PayLinkPage />} />
      <Route path="/portal/:token" element={<PortalPage />} />
      <Route path="*" element={<Notice title="Page not found" text="This link does not lead anywhere." />} />
    </Routes>
  );
}
