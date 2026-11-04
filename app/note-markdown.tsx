'use client';
import ReactMarkdown from 'react-markdown';
export default function NoteMarkdown({text}:{text:string}) {
 return <ReactMarkdown skipHtml components={{a:({href,children}) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt}) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,pre:({children}) => <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{children}</pre>}}>{text}</ReactMarkdown>;
}
