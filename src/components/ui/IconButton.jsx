function IconButton({
  label,
  title = label,
  className = '',
  children,
  type = 'button',
  ...props
}) {
  return (
    <button
      {...props}
      type={type}
      className={['icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={title}
    >
      {children}
    </button>
  )
}

export default IconButton
