from django.urls import re_path

from books.views import api_view, spa_view

urlpatterns = [
    re_path(r'^api(?P<path>/.*)?$', api_view),
    re_path(r'^.*$', spa_view),
]
