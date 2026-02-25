import Layout from '../components/Layout';
import AgentMonitor from '../components/AgentMonitor';

export default function AgentDashboard() {
  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <AgentMonitor />
      </div>
    </Layout>
  );
}
