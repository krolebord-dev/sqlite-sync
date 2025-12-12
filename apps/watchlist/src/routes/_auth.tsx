import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="relative flex items-center justify-center pt-10">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 30 10"
        className="-top-16 -z-10 absolute h-32 w-[500px] text-primary blur-3xl"
      >
        <title>Background</title>
        <ellipse cx="15" cy="5" rx="15" ry="5" fill="currentColor" />
        <rect x="0" y="0" width="30" height="5" fill="currentColor" />
      </svg>
      <Outlet />
    </div>
  );
}
