// The app's triangle mark, in the sidebar and on the sign-in page.
export function Logo({ className = 'logo', size = 20 }: { readonly className?: string; readonly size?: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 L22 20 H2 Z" /></svg>;
}
