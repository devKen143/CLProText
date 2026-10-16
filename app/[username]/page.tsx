import Home from "../page";

export default async function UsernameNotebook({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return <Home notebookUsername={username} />;
}
