import { Link } from 'react-router-dom';

export default function TemplateTagHelp({ projectId, hasTags = true, className = '' }) {
  const message = hasTags
    ? 'To create a template tag, go to Template Library and click Tag on an uploaded template.'
    : 'No template tags yet. Add one in Template Library by clicking Tag on an uploaded template.';

  return (
    <p className={`text-[10px] text-ed-ink3 mt-1 leading-relaxed ${className}`}>
      {message}{' '}
      {projectId ? (
        <Link
          to={`/projects/${projectId}?tab=overview&subtab=templates`}
          className="font-medium text-ed-accent hover:text-ed-accent/80 underline underline-offset-2"
        >
          Open Template Library
        </Link>
      ) : (
        <span className="font-medium text-ed-ink2">Open Template Library</span>
      )}
    </p>
  );
}
