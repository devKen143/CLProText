import Home from "../page";
import { notFound } from "next/navigation";
import {normalizeUsername,validUsername} from "../../lib/sync-contract";
export default async function UsernameNotebook({params}:{params:Promise<{username:string}>}) {
 const {username}=await params;
 const normalized=normalizeUsername(username);
 if(!validUsername(normalized)) notFound();
 return <Home notebookUsername={normalized}/>;
}
