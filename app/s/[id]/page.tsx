import ShareViewer from './viewer';
export const dynamic = 'force-dynamic';
export const metadata = {title:'Shared note | CLProText',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default async function SharePage({params}:{params:Promise<{id:string}>}) {
 const {id}=await params;
 return <ShareViewer id={id}/>;
}
