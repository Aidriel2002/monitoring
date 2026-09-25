import Link from "next/link";

export default function Home() {
  return (
    <div className="h-screen w-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">RUIJIE Monitoring System</h1>
        <p className="text-lg text-gray-600 mb-8">Real-time monitoring for received projects</p>
        <Link
          href="/dashboard"
          className="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
