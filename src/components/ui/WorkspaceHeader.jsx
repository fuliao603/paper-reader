function WorkspaceHeader({ eyebrow, title, description, children }) {
  return (
    <header className="workspace-header">
      <div className="workspace-heading">
        <span className="workspace-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {children ? <div className="workspace-header-aside">{children}</div> : null}
    </header>
  )
}

export default WorkspaceHeader
