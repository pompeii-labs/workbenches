import { Hono } from 'hono';
import InvitesRouter from './invites';
import ProfilesRouter from './profiles';
import TeamsRouter from './teams';

const Router = new Hono();

Router.route('/profiles', ProfilesRouter);
Router.route('/teams', TeamsRouter);
Router.route('/invites', InvitesRouter);

export default Router;
