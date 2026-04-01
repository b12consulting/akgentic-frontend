import { Routes } from '@angular/router';
import { environment } from '../environments/environment';
import { AuthGuard } from './auth.guard';
import { HomeComponent } from './home/home.component';
import { LoginComponent } from './login/login.component';
import { ProcessComponent } from './process/process.component';

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    title: 'Home page',
    canActivate: environment.hideLogin ? [] : [AuthGuard],
  },
  {
    path: 'process/:id',
    component: ProcessComponent,
    title: 'Process page',
    canActivate: environment.hideLogin ? [] : [AuthGuard],
  },
  { path: 'login', component: LoginComponent, title: 'Login page' },
];
