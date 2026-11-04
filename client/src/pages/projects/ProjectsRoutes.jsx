import { Routes, Route, Navigate } from 'react-router-dom';
import ProjectList from './ProjectList.jsx';
import ProjectForm from './ProjectForm.jsx';
import ProjectView from './ProjectView.jsx';
import Timesheet from './Timesheet.jsx';

// Mounted at /time/* in App.jsx
export default function ProjectsRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="/time/projects" replace />} />
      <Route path="projects" element={<ProjectList />} />
      <Route path="projects/new" element={<ProjectForm />} />
      <Route path="projects/:id" element={<ProjectView />} />
      <Route path="projects/:id/edit" element={<ProjectForm />} />
      <Route path="timesheet" element={<Timesheet />} />
      <Route path="*" element={<Navigate to="/time/projects" replace />} />
    </Routes>
  );
}
