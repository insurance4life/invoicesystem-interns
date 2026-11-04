import { Routes, Route } from 'react-router-dom';
import ReportsCenter from './ReportsCenter.jsx';
import ReportView from './ReportView.jsx';

export default function ReportsRoutes() {
  return (
    <Routes>
      <Route index element={<ReportsCenter />} />
      <Route path=":key" element={<ReportView />} />
    </Routes>
  );
}
